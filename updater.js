/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert');
var redis = require('redis');
var bunyan = require('bunyan');
var changefeed = require('changefeed');
var vasync = require('vasync');
var ChangefeedFilter = require('./lib/changefeed-filter');
var UpdateStream = require('./lib/update-stream');
var FlagFilter = require('./lib/flag-filter');
var CNFilter = require('./lib/cn-filter');
var UfdsFilter = require('./lib/ufds-filter');
var NetFilter = require('./lib/net-filter');
var PollerStream = require('./lib/poller-stream');
var ReaperStream = require('./lib/reaper-stream');
var config = require('./lib/config');
var path = require('path');

var confPath;
if (process.argv[2])
	confPath = process.argv[2];
if (confPath === undefined)
	confPath = path.join(__dirname, 'etc', 'config.json');
var conf = config.parse(confPath);

var client = redis.createClient(conf.redis_opts);

var log = bunyan.createLogger({name: 'cns', level: 'trace'});

var ps = new PollerStream({log: log, config: conf});
var cff = new ChangefeedFilter({log: log, config: conf});
var cnf = new CNFilter({log: log, config: conf});
var uf = new UfdsFilter({log: log, config: conf});
var nf = new NetFilter({log: log, config: conf});
var ffs = new FlagFilter({log: log, config: conf});
var s = new UpdateStream({client: client, log: log, config: conf});

var cfOpts = {
	log: log,
	url: 'http://' + conf.vmapi_opts.address,
	instance: conf.changefeed_opts.instance,
	service: 'cns',
	changeKind: {
		resource: conf.changefeed_opts.resource,
		subResources: conf.changefeed_opts.subResources
	}
};
var cfl = changefeed.createListener(cfOpts);
cfl.register();

var initialized = false;

function _bootstrap(_, cb) {
	log.trace('_bootstrap');

	if (!initialized) {
		ps.pipe(cnf);
		cnf.pipe(uf);
		uf.pipe(nf);
		nf.pipe(ffs);
		ffs.pipe(s);
		s.openSerial(false);
	}

	ps.start();
	ps.once('pollFinish', function () {
		log.info('Poll done, committing...');
		if (!initialized) {
			s.closeSerial();

			var rs = new ReaperStream(
			    {log: log,
			        config: conf,
			        client: client});
			rs.pipe(cnf);
			function reap() {
				rs.start();
				setTimeout(reap, 300000);
			}
			setTimeout(reap, 15000);
		}
		cb();
	});
}

function _changefeedInit(_, cb) {
	log.trace('_changefeedInit');
	if (!initialized) {
		cfl.pipe(cff);
		cff.pipe(cnf);
	}
	cb();
}

cfl.on('bootstrap', function _bootstrapInit(info) {
	log.trace('_bootstrapInit: start');
	vasync.pipeline({ 'funcs': [_bootstrap, _changefeedInit] },
	    function (err, results) {
		if (err) {
			log.error({ error: err }, '_bootstrapInit: failed');
			assert.ifError(err);
		} else {
			log.trace('_bootstrapInit: finished');
			initialized = true;
		}
	});
});

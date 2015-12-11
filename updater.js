/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var redis = require('redis');
var bunyan = require('bunyan');
var changefeed = require('changefeed');
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
	},
	backoff: {
		maxTimeout: Infinity,
		minTimeout: 10,
		retries: Infinity
	}
};
var cfl = changefeed.createListener(cfOpts);
cfl.register();

var initialized = false;

function _setupMainPipes() {
	ps.pipe(cnf);
	cnf.pipe(uf);
	uf.pipe(nf);
	nf.pipe(ffs);
	ffs.pipe(s);
	s.openSerial(false);
}

function _setupReaper() {
	var rs = new ReaperStream({log: log, config: conf, client: client});
	rs.pipe(cnf);
	function reap() {
		rs.start();
		setTimeout(reap, 300000);
	}
	setTimeout(reap, 15000);
}

function _bootstrap() {
	log.trace('_bootstrap');

	if (!initialized)
		_setupMainPipes();

	ps.start();
	ps.once('pollFinish', function () {
		log.info('Poll done, committing...');
		if (!initialized) {
			s.closeSerial();
			_setupReaper();
			cfl.pipe(cff);
			cff.pipe(cnf);
			initialized = true;
		}
	});
}

function _fallback() {
	_setupMainPipes();
	ps.start();
	ps.once('pollFinish', function () {
		log.info('First poll done, committing...');
		s.closeSerial();

		function poll() {
			ps.start();
			setTimeout(poll, 10000);
		}
		setTimeout(poll, 10000);
		_setupReaper();
	});
}

cfl.on('bootstrap', _bootstrap);
cfl.on('error', _fallback);

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var redis = require('redis');
var backoff = require('backoff');
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
var ps = new PollerStream({log: log, config: conf});
var cnf = new CNFilter({log: log, config: conf});
var uf = new UfdsFilter({log: log, config: conf});
var nf = new NetFilter({log: log, config: conf});
var ffs = new FlagFilter({log: log, config: conf});
var s = new UpdateStream({client: client, log: log, config: conf});

cfl.register();

var exb = backoff.exponential({
	initialDelay: 10,
	maxDelay: Infinity
});
exb.failAfter(Infinity);

cfl.on('end', function _end() {
	log.error('Changefeed listener ended');
	exb.on('backoff', function _backoff(number, delay) {
		log.warn('Backoff -- retry count: %s delay: %s', number, delay);
	});
	exb.on('ready', function _ready(number, delay) {
		cfl.register();
	});
	exb.backoff();
});

cfl.on('bootstrap', function _setupPipeline(info) {
	log.trace('_setupPipeline: start');
	vasync.pipeline({
		'funcs': [
			function _bootstrap(_, cb) {
				log.trace('_bootstrap');
				ps.pipe(cnf);
				cnf.pipe(uf);
				uf.pipe(nf);
				nf.pipe(ffs);
				ffs.pipe(s);

				s.openSerial(false);
				ps.start();
				ps.once('pollFinish', function () {
					log.info(
					    'first poll done, committing...');
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
					cb();
				});
			},
			function _beginChangefeed(_, cb) {
				log.trace('_beginChangefeed');
				var cff = new ChangefeedFilter(
				    {log: log, config: conf});
				cfl.pipe(cff);
				cff.pipe(cnf);
				exb.reset();
				cb();
			}
		]
	}, function (err, results) {
		if (err) {
			log.error({ error: err }, '_setupPipeline: failed');
		} else {
			log.trace('_setupPipeline: finished');
		}
	});
});

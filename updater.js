/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var redis = require('redis');
var bunyan = require('bunyan');
var cueball = require('cueball');
var util = require('util');
var changefeed = require('changefeed');
var ChangefeedFilter = require('./lib/changefeed-filter');
var UpdateStream = require('./lib/update-stream');
var FlagFilter = require('./lib/flag-filter');
var CNFilter = require('./lib/cn-filter');
var UfdsFilter = require('./lib/ufds-filter');
var NetPoolFilter = require('./lib/net-pool-filter');
var NetFilter = require('./lib/net-filter');
var NAPILegacyFilter = require('./lib/napi-legacy-filter');
var PollerStream = require('./lib/poller-stream');
var ReaperStream = require('./lib/reaper-stream');
var config = require('./lib/config');
var path = require('path');

var FSM = require('mooremachine').FSM;

var confPath;
if (process.argv[2])
	confPath = process.argv[2];
if (confPath === undefined)
	confPath = path.join(__dirname, 'etc', 'config.json');
var conf = config.parse(confPath);

var CF_REAP_TIME = 600;
var FALLBACK_REAP_TIME = 40;

var client = redis.createClient(conf.redis_opts);

var log = bunyan.createLogger({name: 'cns',
    level: process.env.LOGLEVEL || 'debug'});

var agent = new cueball.HttpAgent({
	resolvers: [conf.binder_domain],
	spares: 2,
	maximum: 4
});

/* Common options object for all the streams and filters. */
var opts = {
	log: log,
	config: conf,
	agent: agent,
	client: client
};

var ps = new PollerStream(opts);
var cff = new ChangefeedFilter(opts);
var cnf = new CNFilter(opts);
var uf = new UfdsFilter(opts);
var nlf = new NAPILegacyFilter(opts);
var npf = new NetPoolFilter(opts);
var nf = new NetFilter(opts);
var ffs = new FlagFilter(opts);
var s = new UpdateStream(opts);
var rs = new ReaperStream(opts);

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

var EventEmitter = require('events').EventEmitter;
var pollTimeEmitter = new EventEmitter();
setInterval(function () {
	pollTimeEmitter.emit('timeout');
}, 10000);

function AppFSM() {
	FSM.call(this, 'initial');
}
util.inherits(AppFSM, FSM);

AppFSM.prototype.state_initial = function (on, once, timeout) {
	var self = this;

	ps.pipe(cnf);
	cnf.pipe(uf);
	uf.pipe(npf);
	npf.pipe(nf);
	nf.pipe(ffs);
	ffs.pipe(s);
	rs.pipe(cnf);

	once(cfl, 'bootstrap', function () {
		self.gotoState('cfFirstPoll');
	});
	once(cfl, 'error', function () {
		self.gotoState('fallbackFirstPoll');
	});
	cfl.register();
};

AppFSM.prototype.state_cfFirstPoll = function (on, once, timeout) {
	var self = this;
	s.openSerial(false);
	ps.start();
	once(ps, 'pollFinish', function () {
		log.info('Poll done, committing...');
		s.closeSerial();
		self.gotoState('cfRunning');
	});
	once(cfl, 'error', function () {
		self.gotoState('fallbackFirstPoll');
	});
};

AppFSM.prototype.state_cfRunning = function (on, once, timeout) {
	var self = this;
	cfl.pipe(cff);
	cff.pipe(cnf);
	rs.setReapTime(CF_REAP_TIME);
	rs.start();

	once(cfl, 'bootstrap', function () {
		self.gotoState('cfFirstPoll');
	});

	once(cfl, 'error', function () {
		self.gotoState('fallback');
	});
};

AppFSM.prototype.state_fallbackFirstPoll = function (on, once, timeout) {
	var self = this;
	s.openSerial(false);
	ps.start();
	once(ps, 'pollFinish', function () {
		log.info('Poll done, committing...');
		s.closeSerial();
		self.gotoState('fallback');
	});
	on(cfl, 'error', function () {
		/* Ignore any CF errors while in fallback mode. */
	});
	once(cfl, 'bootstrap', function () {
		self.gotoState('cfFirstPoll');
	});
};

AppFSM.prototype.state_fallback = function (on, once, timeout) {
	var self = this;
	rs.setReapTime(FALLBACK_REAP_TIME);
	rs.start();
	on(pollTimeEmitter, 'timeout', function () {
		ps.start();
	});
	on(cfl, 'error', function () {
		/* Ignore any CF errors while in fallback mode. */
	});
	once(cfl, 'bootstrap', function () {
		self.gotoState('cfFirstPoll');
	});
};

var app = new AppFSM();
app.on('stateChanged', function (state) {
	log.debug('app state changed to %s', state);
});

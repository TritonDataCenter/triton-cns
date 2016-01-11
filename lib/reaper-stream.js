/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = ReaperStream;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var restify = require('restify-clients');
var qs = require('querystring');
var EventEmitter = require('events').EventEmitter;

var consts = require('./consts');

var FSM = require('mooremachine').FSM;

/* Attempt to reap VMs that haven't been visited in REAP_TIME seconds. */
var REAP_TIME = 300;

function ReaperFSM(strm, opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'ReaperStream'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.vmapi_opts, 'config.vmapi_opts');
	assert.string(opts.config.vmapi_opts.address, 'vmapi_opts.address');

	assert.object(opts.client, 'options.client');
	this.redis = opts.client;

	this.stream = strm;
	this.remaining = [];
	this.vmuuid = undefined;
	this.lastError = undefined;
	this.retries = 3;

	this.client = restify.createJsonClient({
		url: 'http://' + opts.config.vmapi_opts.address
	});

	FSM.call(this, 'idle');
}
util.inherits(ReaperFSM, FSM);

ReaperFSM.prototype.fetch = function (uuid) {
	var eve = new EventEmitter();
	var self = this;
	eve.send = function () {
		self.client.get('/vms/' + uuid, function (err, req, res, obj) {
			if (err) {
				eve.emit('error', err);
				return;
			}
			utils.cleanVM(obj);
			eve.emit('result', obj);
		});
	};
	return (eve);
};

ReaperFSM.prototype.start = function () {
	this.emit('startAsserted');
};

ReaperFSM.prototype.wake = function () {
	this.emit('wakeAsserted');
};

ReaperFSM.prototype.state_idle = function (on, once) {
	var self = this;
	once(this, 'startAsserted', function () {
		self.gotoState('listVms');
	});
};

ReaperFSM.prototype.state_listVms = function (on, once, timeout) {
	var self = this;
	timeout(1000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		self.gotoState('listError');
	});
	var req = FSM.wrap(this.redis.keys).call(this.redis, 'vm:*');

	once(req, 'error', function (err) {
		self.lastError = err;
		self.gotoState('listError');
	});
	once(req, 'return', function (keys) {
		for (var i = 0; i < keys.length; ++i) {
			var parts = keys[i].split(':');
			if (parts.length === 2 && parts[0] === 'vm') {
				self.remaining.push(parts[1]);
			}
		}

		self.log.debug('pushed %d candidates for reaping',
		    self.remaining.length);

		self.gotoState('next');
	});

	req.run();
};

ReaperFSM.prototype.state_listError = function (on, once, timeout) {
	var self = this;
	this.log.error(this.lastError,
	    'error while listing VMs in redis, retry in 1s');
	timeout(1000, function () {
		self.gotoState('listVms');
	});
};

ReaperFSM.prototype.state_next = function () {
	var self = this;
	self.retries = 3;
	if (self.remaining.length > 0) {
		self.vmuuid = self.remaining.shift();
		self.gotoState('checkLastVisited');
	} else {
		self.log.debug('reaping complete');
		self.gotoState('idle');
	}
};

ReaperFSM.prototype.state_checkLastVisited = function (on, once, timeout) {
	var self = this;
	var log = self.log.child({uuid: self.vmuuid});
	timeout(1000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		self.gotoState('checkError');
	});

	var req = FSM.wrap(self.redis.hget).call(self.redis,
	    'vm:' + self.vmuuid, 'last_visit');

	once(req, 'error', function (err) {
		self.lastError = err;
		self.gotoState('checkError');
	});

	once(req, 'return', function (val) {
		if (val === null) {
			log.warn('vm has no last_visited record, skipping');
			self.gotoState('next');
			return;
		}

		var now = Math.round((new Date()).getTime() / 1000);
		var lastVisited = parseInt(val, 10);
		if (now - lastVisited > REAP_TIME) {
			log.trace('reaping, last visited %d sec ago',
			    (now - lastVisited));
			self.gotoState('checkReaped');
		} else {
			self.gotoState('next');
		}
	});

	req.run();
};

ReaperFSM.prototype.state_checkReaped = function (on, once, timeout) {
	var self = this;
	timeout(1000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		self.gotoState('checkError');
	});
	var req = FSM.wrap(self.redis.hget).call(self.redis,
	    'vm:' + self.vmuuid, 'reaped');

	once(req, 'error', function (err) {
		self.lastError = err;
		self.gotoState('checkError');
	});

	once(req, 'return', function (val) {
		/*
		 * If we found something, this is the second time we've
		 * visited this VM and it's still destroyed. We can
		 * forget that it existed now.
		 */
		if (val !== null) {
			self.redis.del('vm:' + self.vmuuid);
			self.gotoState('next');
			return;
		}

		self.gotoState('fetchAndPush');
	});

	req.run();
};

ReaperFSM.prototype.state_fetchAndPush = function (on, once, timeout) {
	var self = this;
	timeout(5000, function () {
		self.lastError = new Error(
		    'Timed out waiting for VMAPI response');
		self.gotoState('checkError');
	});
	var req = self.fetch(self.vmuuid);
	once(req, 'error', function (err) {
		self.lastError = new Error('Error from VMAPI: ' +
		    err.name + ': ' + err.message);
		self.lastError.name = 'VMAPIError';
		self.lastError.origin = err;
		self.gotoState('checkError');
	});
	once(req, 'result', function (obj) {
		var wantMore = self.stream.push(obj);

		if (obj.state === 'destroyed' || obj.destroyed)
			self.redis.hset('vm:' + self.vmuuid, 'reaped', 'yes');

		if (wantMore)
			self.gotoState('next');
		else
			self.gotoState('sleep');
	});
	req.send();
};

ReaperFSM.prototype.state_sleep = function (on, once, timeout) {
	var self = this;
	timeout(100, function () {
		self.gotoState('next');
	});
	once(this, 'wakeAsserted', function () {
		self.gotoState('next');
	});
};

ReaperFSM.prototype.state_checkError = function (on, once, timeout) {
	var self = this;
	--(self.retries);
	var log = self.log.child({uuid: self.vmuuid,
	    retries_remaining: self.retries});
	if (self.retries > 0) {
		log.error(self.lastError,
		    'error while checking vm, retrying in 1s');
		timeout(1000, function () {
			self.gotoState('checkLastVisited');
		});
	} else {
		log.error(self.lastError,
		    'error while checking vm, out of retries -- will skip');
		timeout(5000, function () {
			self.gotoState('next');
		});
	}
};

function ReaperStream(opts) {
	this.fsm = new ReaperFSM(this, opts);
	var streamOpts = {
		objectMode: true
	};
	stream.Readable.call(this, streamOpts);
}
util.inherits(ReaperStream, stream.Readable);

ReaperStream.prototype._read = function () {
	this.fsm.start();
	this.fsm.wake();
};

ReaperStream.prototype.start = function () {
	this.fsm.start();
};

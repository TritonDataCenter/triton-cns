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

var consts = require('./consts');

/* Attempt to reap VMs that haven't been visited in REAP_TIME seconds. */
var REAP_TIME = 300;

function ReaperStream(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'ReaperStream'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.vmapi_opts, 'config.vmapi_opts');
	assert.string(opts.config.vmapi_opts.address, 'vmapi_opts.address');

	assert.object(opts.client, 'options.client');
	this.redis = opts.client;

	this.running = false;
	this.checking = false;
	this.gotList = false;
	this.remaining = [];

	this.client = restify.createJsonClient({
		url: 'http://' + opts.config.vmapi_opts.address
	});

	var streamOpts = {
		objectMode: true
	};
	stream.Readable.call(this, streamOpts);
}
util.inherits(ReaperStream, stream.Readable);

ReaperStream.prototype._read = function () {
	this.check();
};

ReaperStream.prototype.start = function () {
	if (this.running || this.checking)
		return;
	this.running = true;
	this.gotList = false;
	this.checking = false;

	var self = this;
	var redis = this.redis;
	redis.keys('vm:*', function (err, keys) {
		if (err) {
			self.log.error({
				err: err
			}, 'failed listing redis keys, retry in 1s');
			self.running = false;
			setTimeout(self.start.bind(self), 1000);
			return;
		}

		for (var i = 0; i < keys.length; ++i) {
			var parts = keys[i].split(':');
			if (parts.length === 2 && parts[0] === 'vm') {
				self.remaining.push(parts[1]);
			}
		}

		self.log.debug('pushed %d candidates for reaping',
		    self.remaining.length);

		self.gotList = true;
		self.check();
	});
};

ReaperStream.prototype.check = function () {
	if (!this.running)
		return;
	if (this.checking || !this.gotList)
		return;
	this.checking = true;

	var self = this;
	var redis = this.redis;
	var uuid = this.remaining.shift();
	if (uuid === undefined) {
		self.log.debug('reaping finished');
		self.checking = false;
		self.running = false;
		self.gotList = false;
		self.emit('pollFinish');
		return;
	}
	var log = self.log.child({uuid: uuid});
	redis.hget('vm:' + uuid, 'last_visit', function (err, val) {
		if (err) {
			log.error({
				err: err
			}, 'failed looking up last_visit, retry in 1s');
			self.checking = false;
			self.remaining.unshift(uuid);
			setTimeout(self.check.bind(self), 1000);
			return;
		}

		if (val === null) {
			log.warn('vm has no last_visited record, skipping');
			setTimeout(self.check.bind(self), 100);
			return;
		}

		var now = Math.round((new Date()).getTime() / 1000);
		var lastVisited = parseInt(val, 10);
		if (now - lastVisited > REAP_TIME) {
			redis.hget('vm:' + uuid, 'reaped',
			    function (err2, rval) {
				if (!err2 && rval !== null) {
					redis.del('vm:' + uuid);
					self.checking = false;
					self.check();
					return;
				}

				self.fetch(uuid, function (err3, obj) {
					log.trace('reaping, last visited %d ' +
					    'sec ago', (now - lastVisited));
					self.checking = false;
					if (err3)
						return;
					if (self.push(obj))
						self.check();

					if (obj.state === 'destroyed' ||
					    obj.destroyed) {
						redis.hset('vm:' + uuid,
						    'reaped', 'yes');
					}
				});
			});

		} else {
			self.checking = false;
			self.check();
		}
	});
};

ReaperStream.prototype.fetch = function (uuid, cb) {
	var self = this;
	this.client.get('/vms/' + uuid, function (err, req, res, obj) {
		if (err) {
			self.log.warn({
				uuid: uuid,
				err: err
			}, 'failed fetching vm from vmapi');
			cb(err);
			return;
		}

		/* Delete some attribs that can get pretty big. */
		delete (obj.customer_metadata['user-script']);
		delete (obj.customer_metadata['root_authorized_keys']);
		delete (obj.datasets);
		delete (obj.resolvers);
		delete (obj.zfs_filesystem);
		delete (obj.zonepath);

		cb(null, obj);
	});
};

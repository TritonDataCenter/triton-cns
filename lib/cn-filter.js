/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = CNFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');

var consts = require('./consts');

var UPDATE_INTERVAL = 30000;

function CNFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'CNFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.cnapi_opts, 'config.cnapi_opts');
	this.config = opts.config.cnapi_opts;
	assert.string(this.config.address, 'cnapi_opts.address');
	assert.object(opts.pollerStream, 'options.pollerStream');
	this.pollerStream = opts.pollerStream;

	assert.optionalObject(opts.agent, 'options.agent');

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address,
		agent: opts.agent
	});

	this.cache = undefined;

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};

	var self = this;
	this.timer = setInterval(function () {
		self.updateServers();
	}, UPDATE_INTERVAL);

	stream.Transform.call(this, xformOpts);
}
util.inherits(CNFilter, stream.Transform);

CNFilter.prototype.updateServers = function (cb) {
	var self = this;
	self.client.get('/servers?extras=status',
	    function (err, req, res, objs) {
		if (err) {
			self.log.warn(err,
			    'failed to update server cache');
			if (cb)
				cb(err);
			return;
		}

		if (self.cache === undefined)
			self.cache = {};
		objs.forEach(function (obj) {
			var oldObj = self.cache[obj.uuid];
			var newObj = cutServerObj(obj);

			self.cache[obj.uuid] = newObj;

			if (oldObj && newObj.down !== oldObj.down) {
				self.log.info({
					uuid: obj.uuid,
					newObj: newObj,
					oldObj: oldObj
				}, 'noticed CN status change, polling');
				self.pollerStream.start({
					server_uuid: obj.uuid,
					state: 'active'
				});
			}
		});
		if (cb)
			cb();
	});
};

CNFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	if (typeof (vm.server_uuid) !== 'string') {
		vm.server = {};
		this.push(vm);
		cb();
		return;
	}
	assert.string(vm.server_uuid, 'vm.server_uuid');

	var self = this;
	if (this.cache === undefined) {
		this.updateServers(function () {
			self._transform(vm, enc, cb);
		});
		return;
	}

	vm.server = this.cache[vm.server_uuid];
	if (typeof (vm.server) !== 'object' || !vm.server.uuid) {
		this.log.warn({
			vm: vm.uuid,
			server: vm.server_uuid
		}, 'failed to find server, dropping VM');
		cb();
		return;
	}
	vm.timers = vm.timers || [];
	vm.timers.push({t: new Date(), n: 'cn-filter'});
	self.push(vm);
	cb();
};

function cutServerObj(obj) {
	var cutObj = {};
	cutObj.uuid = obj.uuid;
	assert.string(obj.status);
	cutObj.status = obj.status;
	assert.string(obj.last_heartbeat);
	cutObj.last_heartbeat = new Date(obj.last_heartbeat);
	cutObj.heartbeat_age = (new Date()) - cutObj.last_heartbeat;
	assert.string(obj.last_boot);
	cutObj.last_boot = new Date(obj.last_boot);
	cutObj.last_boot_age = (new Date()) - cutObj.last_boot;

	/*
	 * "CN that is not running" includes CNs with a non-"running" status
	 * and a last_heartbeat >1min ago, those that have not heartbeated in
	 * the last 2 min, and CNs that have only booted up in the last
	 * 2 min.
	 *
	 * This policy is here because it is shared between the cache update
	 * logic here and the logic in flag-filter.js
	 */
	cutObj.down = ((cutObj.status !== 'running' &&
	    cutObj.heartbeat_age > 60000) ||
	    cutObj.heartbeat_age > 120000 ||
	    cutObj.last_boot_age < 120000);
	return (cutObj);
}

CNFilter.cutServerObj = cutServerObj;

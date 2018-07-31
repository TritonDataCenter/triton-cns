/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

module.exports = NetPoolFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');

var consts = require('./consts');

var UPDATE_INTERVAL = 600000;

function NetPoolFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'NetPoolFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.napi_opts, 'config.napi_opts');
	this.config = opts.config.napi_opts;
	assert.string(this.config.address, 'napi_opts.address');

	assert.optionalObject(opts.agent, 'options.agent');

	this.client = restify.createJsonClient(utils.getRestifyClientOptions({
		url: 'http://' + this.config.address,
		agent: opts.agent
	}));
	this.cache = undefined;

	this.timer = setInterval(this.updatePools.bind(this), UPDATE_INTERVAL);

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(NetPoolFilter, stream.Transform);

NetPoolFilter.prototype.updatePools = function (cb) {
	assert.optionalFunc(cb, 'callback');
	var self = this;
	this.client.get('/network_pools', function (err, req, res, objs) {
		if (err) {
			self.log.warn(err,
			    'failed to update network pools cache');
			if (cb)
				cb(err);
			return;
		}

		var cache = {};
		objs.forEach(function (obj) {
			obj.networks.forEach(function (networkUuid) {
				if (cache[networkUuid] === undefined)
					cache[networkUuid] = [];
				cache[networkUuid].push(obj.uuid);
			});
		});
		self.cache = cache;
		if (cb)
			cb(null);
	});
};

NetPoolFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.arrayOfObject(vm.nics, 'vm.nics');

	var self = this;
	if (this.cache === undefined) {
		this.updatePools(function () {
			self._transform(vm, enc, cb);
		});
		return;
	}

	vm.nics.forEach(function (nic) {
		nic.network_pools = self.cache[nic.network_uuid];
	});

	vm.timers = vm.timers || [];
	vm.timers.push({t: new Date(), n: 'net-pool-filter'});
	this.push(vm);
	cb();
};

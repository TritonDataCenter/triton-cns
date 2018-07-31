/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

module.exports = NetworkInfoFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');
var vasync = require('vasync');

var consts = require('./consts');

function NetworkInfoFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'NetworkInfoFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.napi_opts, 'config.napi_opts');
	this.config = opts.config.napi_opts;
	assert.string(this.config.address, 'napi_opts.address');

	assert.optionalObject(opts.agent, 'options.agent');

	this.client = restify.createJsonClient(utils.getRestifyClientOptions({
		url: 'http://' + this.config.address,
		agent: opts.agent
	}));

	this.cache = LRUCache({
		max: 32 * 1024 * 1024,
		length: function jsonLength(t) {
			return (JSON.stringify(t).length);
		},
		maxAge: 1 * 60 * 1000
	});

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(NetworkInfoFilter, stream.Transform);

NetworkInfoFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.arrayOfObject(vm.nics, 'vm.nics');

	var self = this;
	vasync.forEachParallel({
		inputs: vm.nics,
		func: doNic
	}, function (err) {
		if (err) {
			self.log.warn({
			    vm: vm.uuid,
			    err: err,
			    networks: vm.nics.map(function (n) {
				return (n.network_uuid);
			    })
			}, 'got error retrieving NAPI records, dropping');
			self.emit('drop', vm);
			cb();
			return;
		}
		vm.timers = vm.timers || [];
		vm.timers.push({t: new Date(), n: 'network-info-filter'});
		self.push(vm);
		cb();
	});

	function doNic(nic, ccb) {
		self.getNetwork(nic.network_uuid, function (err, napiObj) {
			if (err) {
				ccb(err);
				return;
			}

			assert.strictEqual(napiObj.uuid, nic.network_uuid);
			nic.network = napiObj;

			ccb();
		});
	}
};

NetworkInfoFilter.prototype.getNetwork = function (uuid, cb) {
	var v = this.cache.get(uuid);
	if (v) {
		cb(null, v);
		return;
	}

	var self = this;
	this.client.get('/networks/' + uuid, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}

		var cutObj = {};
		cutObj.name = obj.name;
		cutObj.owner_uuids = obj.owner_uuids;
		cutObj.uuid = obj.uuid;

		self.cache.set(uuid, cutObj);
		cb(null, cutObj);
	});
};

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

function CNFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'CNFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.cnapi_opts, 'config.cnapi_opts');
	this.config = opts.config.cnapi_opts;
	assert.string(this.config.address, 'cnapi_opts.address');

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address
	});

	this.cache = LRUCache({
		max: 32*1024*1024,
		length: function (t) { return (JSON.stringify(t).length); },
		maxAge: 1 * 60 * 1000
	});

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(CNFilter, stream.Transform);

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
	this.getServer(vm.server_uuid, function (err, server) {
		if (err) {
			self.log.warn({
			    vm: vm.uuid,
			    user: vm.server_uuid,
			    err: err
			}, 'got error retrieving CN record, dropping');
			cb();
			return;
		}

		vm.server = server;
		self.push(vm);
		cb();
	});
};

CNFilter.prototype.getServer = function (uuid, cb) {
	var v = this.cache.get(uuid);
	if (v) {
		cb(null, v);
		return;
	}

	var self = this;
	this.client.get('/servers/' + uuid, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}

		var cutObj = {};
		cutObj.uuid = obj.uuid;
		cutObj.status = obj.status;
		cutObj.last_heartbeat = obj.last_heartbeat;
		cutObj.last_boot = obj.last_boot;

		self.cache.set(uuid, cutObj);
		cb(null, cutObj);
	});
};

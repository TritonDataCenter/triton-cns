/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = UfdsFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var querystring = require('querystring');

var consts = require('./consts');

function UfdsFilter(opts) {
	assert.object(opts, 'options');

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.mahi_opts, 'config.mahi_opts');
	this.config = opts.config.mahi_opts;
	assert.string(this.config.address, 'mahi_opts.address');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'UfdsFilter'});

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address
	});

	this.cache = LRUCache({
		max: 32*1024*1024,
		length: function (t) { return (JSON.stringify(t).length); },
		maxAge: 5 * 60 * 1000
	});

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(UfdsFilter, stream.Transform);

UfdsFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.string(vm.owner_uuid, 'vm.owner_uuid');

	var self = this;
	this.getUser(vm.owner_uuid, function (err, owner) {
		if (err) {
			self.log.warn({
			    vm: vm.uuid,
			    user: vm.owner_uuid,
			    err: err
			}, 'got error retrieving user, dropping');
			cb();
			return;
		}

		vm.owner = owner;
		self.push(vm);
		cb();
	});
};

UfdsFilter.prototype.getUser = function (uuid, cb) {
	var v = this.cache.get(uuid);
	if (v) {
		cb(null, v);
		return;
	}

	var self = this;
	this.client.get('/accounts/' + uuid, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}

		obj = obj.account;
		delete (obj.keys);
		self.cache.set(uuid, obj);
		cb(null, obj);
	});
};

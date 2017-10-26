/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = NAPILegacyFilter;

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

function NAPILegacyFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'NAPILegacyFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.napi_opts, 'config.napi_opts');
	this.config = opts.config.napi_opts;
	assert.string(this.config.address, 'napi_opts.address');

	assert.optionalObject(opts.agent, 'options.agent');

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address,
		agent: opts.agent
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
util.inherits(NAPILegacyFilter, stream.Transform);

NAPILegacyFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.arrayOfObject(vm.nics, 'vm.nics');

	var nicsToFix = [];
	vm.nics.forEach(function (nic) {
		if (typeof (nic.network_uuid) !== 'string' ||
		    nic.network_uuid === '' ||
		    (!Array.isArray(nic.ips) && !nic.ip)) {
			nicsToFix.push(nic);
		}
	});

	if (nicsToFix.length < 1) {
		this.push(vm);
		cb();
		return;
	}

	var self = this;
	vasync.forEachParallel({
		inputs: nicsToFix,
		func: fixNic
	}, function (err, res) {
		if (err) {
			self.log.warn({
			    vm: vm.uuid,
			    err: err,
			    nics: nicsToFix.map(function (n) {
				return (n.mac);
			    })
			}, 'got error retrieving NAPI records, dropping');
			self.emit('drop', vm);
			cb();
			return;
		}
		vm.timers = vm.timers || [];
		vm.timers.push({t: new Date(), n: 'napi-legacy-filter'});
		self.push(vm);
		cb();
	});

	function fixNic(nic, ccb) {
		self.getNic(nic.mac, function (err, napiObj) {
			if (err && err.statusCode === 404) {
				self.guessNetwork(nic, function (err2, uuid) {
					if (err2) {
						ccb(err2);
						return;
					}
					nic.network_uuid = uuid;
					ccb();
				});
				return;
			} else if (err) {
				ccb(err);
				return;
			}

			assert.strictEqual(napiObj.mac, nic.mac);
			if (napiObj.belongs_to_uuid !== vm.uuid) {
				ccb(new Error('NAPI NIC belongs_to_uuid ' +
				    'does not match VM'));
				return;
			}
			nic.network_uuid = napiObj.network_uuid;
			nic.ip = napiObj.ip;
			nic.nic_tag = napiObj.nic_tag;
			if (!nic.ips)
				nic.ips = napiObj.ips;

			ccb();
		});
	}
};

NAPILegacyFilter.prototype.guessNetwork = function (nic, cb) {
	var q = {
		nic_tag: nic.nic_tag,
		vlan_id: nic.vlan_id
	};
	q = qs.stringify(q);
	this.client.get('/networks?' + q, function (err, req, res, objs) {
		if (err) {
			cb(err);
			return;
		}
		assert.arrayOfObject(objs);
		if (objs.length === 1) {
			cb(null, objs[0].uuid);
		} else {
			cb(new Error('No matching single network'));
		}
	});
};

NAPILegacyFilter.prototype.getNic = function (mac, cb) {
	var v = this.cache.get(mac);
	if (v) {
		cb(null, v);
		return;
	}

	var self = this;
	var urlMac = mac.replace(/:/g, '');
	this.client.get('/nics/' + urlMac, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}

		var cutObj = {};
		cutObj.mac = obj.mac;
		cutObj.belongs_to_uuid = obj.belongs_to_uuid;
		cutObj.ips = obj.ips;
		cutObj.ip = obj.ip;
		cutObj.nic_tag = obj.nic_tag;
		cutObj.network_uuid = obj.network_uuid;

		self.cache.set(mac, cutObj);
		cb(null, cutObj);
	});
};

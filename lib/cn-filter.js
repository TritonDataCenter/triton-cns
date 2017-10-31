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
var crypto = require('crypto');

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
	self.client.get('/servers?setup=true&extras=status',
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
			self.pushFakeVM(newObj);

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

function genRandomMAC() {
	var hex = crypto.randomBytes(6).toString('hex');
	/* JSSTYLED */
	var mac = hex.replace(/(.{2})(?=.)/g, '$1:');
	return (mac);
}

CNFilter.prototype.pushFakeVM = function (server) {
	/*
	 * So, this is a somewhat awful hack. We want to generate CMON records
	 * for each CN, at $uuid.cmon.suffix. To do this, we push onto the
	 * pipeline here a "fake" VM for each CN.
	 *
	 * The fake VM is owned by admin and has to have a smartdc_role tag
	 * set so that the admin force-listing kicks in. However, we don't want
	 * to actually list any of its IP addresses in DNS or else some
	 * operators who like their security by obscurity will have a fit.
	 *
	 * So we make only a fake admin NIC for the server. The code in
	 * net-filter.js will cleave this NIC out for us, but set everything
	 * else up properly, and we will generate only CMON records since we
	 * have no listable IP addresses left. Winner.
	 *
	 * The biggest problem here is that we really don't want
	 * NapiLegacyFilter to look up our faked MAC address and find a real
	 * NIC, or else its double-check on the belongs_to_uuid will fail and
	 * this fake VM will get dropped.
	 *
	 * However, we're going to be doing this again periodically, so if
	 * we just generate a new random MAC each time, even if we collide
	 * once and get dropped, it's super unlikely it'll happen every time.
	 * So we'll eventually get our CMON record in DNS and it'll stick
	 * around since pipeline drops don't remove things from DNS.
	 */
	var mac = genRandomMAC();
	var vm = {
		uuid: server.uuid,
		state: 'running',
		owner_uuid: 'admin',
		server_uuid: server.uuid,
		server: server,
		customer_metadata: {},
		tags: {
			'smartdc_role': server.hostname
		},
		nics: [ {
			nic_tag: 'admin',
			ip: '192.0.2.1',
			vlan_id: 0,
			mac: mac
		} ],
		origin: 'fake-cn',
		alias: server.hostname
	};
	vm.timers = vm.timers || [];
	vm.timers.push({t: new Date(), n: 'cn-filter'});
	this.log.trace({vm: vm}, 'pushing fake CN vm');
	this.push(vm);
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
		this.emit('drop', vm);
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
	cutObj.hostname = obj.hostname;

	assert.string(obj.last_boot);
	cutObj.last_boot = new Date(obj.last_boot);
	cutObj.last_boot_age = (new Date()) - cutObj.last_boot;

	/*
	 * Don't bother looking for a heartbeat from a server that isn't
	 * set up yet. These are always "down".
	 */
	if (obj.setup === false || typeof (obj.last_heartbeat) !== 'string') {
		cutObj.down = true;
		return (cutObj);
	}

	assert.string(obj.last_heartbeat);
	cutObj.last_heartbeat = new Date(obj.last_heartbeat);
	cutObj.heartbeat_age = (new Date()) - cutObj.last_heartbeat;

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
	    cutObj.heartbeat_age > 3600000) ||
	    cutObj.last_boot_age < 120000);
	return (cutObj);
}

CNFilter.cutServerObj = cutServerObj;

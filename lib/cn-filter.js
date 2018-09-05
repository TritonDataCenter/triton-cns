/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

module.exports = CNFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var crypto = require('crypto');

var consts = require('./consts');

var FSM = require('mooremachine').FSM;

var UPDATE_INTERVAL = 30000;
var CNAPI_TIMEOUT = 10000;
var RETRY_INTERVAL = 5000;

/*
 * Rate limits for how often we will insert fake CN VM objects into the
 * pipeline.
 *
 * These are in "fake VMs per second", so a value of 1 / N means
 * "1 fake VM per N seconds".
 */
var FAKECN_MIN_RATE = 1 / 30;
var FAKECN_MAX_RATE = 1 / 2;


/*
 * A simple FSM abstraction for "drip-feeding" chunks into a stream. It takes
 * an upper and lower rate for how many chunks per second to feed in -- we
 * start at the maximum rate, and if the stream is returning `false` from
 * push() we will quickly back off to the minimum rate. Then, if it starts
 * returning `true`, we gradually go back to the maximum rate again.
 */
function DripFeederFSM(log, strm, minRate, maxRate) {
	assert.object(strm, 'stream');
	this.log = log.child({ component: DripFeederFSM });
	this.stream = strm;
	this.queue = [];
	this.minRate = minRate;
	this.maxRate = maxRate;
	this.rate = this.maxRate;
	this.lastPush = Date.now();
	FSM.call(this, 'empty');
}
util.inherits(DripFeederFSM, FSM);

DripFeederFSM.prototype.push = function (chunk) {
	this.queue.push(chunk);
	this.emit('pushed');
};

DripFeederFSM.prototype.state_empty = function (S) {
	assert.ok(this.queue.length === 0);
	this.log.trace('drip queue empty');
	S.on(this, 'pushed', function () {
		S.gotoState('sleep');
	});
};

DripFeederFSM.prototype.state_sleep = function (S) {
	var now = Date.now();

	/* Work out time of the next drip from the rate. */
	var tnext = Math.round(this.lastPush + 1000 / this.rate);

	/* Compare to tnext - 10, no point in making a timer for <10ms away. */
	if (now < tnext - 10) {
		S.timeout(tnext - now, function () {
			S.gotoState('drip');
		});
	} else {
		/* Drip is overdue, just do it now. */
		S.gotoState('drip');
	}
};

/*
 * A push into a full stream decreases our drip rate by this factor (until we
 * hit minRate). Must be < 1.0, the smaller it is the faster we back off.
 */
var DRIP_RATE_DOWN_FACTOR = 0.5;
/*
 * A push into a non-full stream increases our drip rate by this factor (until
 * we hit maxRate). Must be > 1.0, the larger it is the faster we move back
 * towards maxRate after a blip.
 *
 * At a value of 1.1, if the DOWN_FACTOR is 0.5, it will take about 8 non-full
 * push()es to undo the effect of one full push().
 */
var DRIP_RATE_UP_FACTOR = 1.1;

DripFeederFSM.prototype.state_drip = function (S) {
	var chunk = this.queue.shift();
	assert.object(chunk, 'chunk');

	var ret = this.stream.push(chunk);
	this.lastPush = Date.now();

	/* stream.push() returns false for "pipeline is full", else true. */
	if (ret === false) {
		this.log.trace('pipeline is full, reducing drip rate');
		this.rate *= DRIP_RATE_DOWN_FACTOR;
		if (this.rate < this.minRate) {
			this.rate = this.minRate;
			this.log.warn('pipeline is full, drip-rate at minimum');
		}
	} else {
		this.rate *= DRIP_RATE_UP_FACTOR;
		if (this.rate > this.maxRate)
			this.rate = this.maxRate;
	}
	if (this.queue.length > 0) {
		S.gotoState('sleep');
	} else {
		S.gotoState('empty');
	}
};

/*
 * FSM to manage periodic updates to the CN cache and retries after timeout
 * or error.
 */
function UpdateCNCacheFSM(cnf, dfr) {
	assert.object(cnf, 'cnfilter');
	this.cnfilter = cnf;
	this.dripfeeder = dfr;
	this.waiters = [];
	FSM.call(this, 'sleep');
}
util.inherits(UpdateCNCacheFSM, FSM);

UpdateCNCacheFSM.prototype.afterUpdate = function (cb) {
	this.waiters.push(cb);
	if (this.isInState('sleep')) {
		this.emit('updateAsserted');
	}
};

UpdateCNCacheFSM.prototype.state_sleep = function (S) {
	S.timeout(UPDATE_INTERVAL, function () {
		S.gotoState('update');
	});
	S.on(this, 'updateAsserted', function () {
		S.gotoState('update');
	});
};

UpdateCNCacheFSM.prototype.state_retry = function (S) {
	S.timeout(RETRY_INTERVAL, function () {
		S.gotoState('update');
	});
};

UpdateCNCacheFSM.prototype.state_update = function (S) {
	var self = this;
	var cnf = this.cnfilter;
	var creq = cnf.client.get('/servers?setup=true&extras=status',
	    S.callback(function (err, req, res, objs) {
		if (err) {
			cnf.log.warn(err, 'failed to update server cache');
			S.gotoState('retry');
			return;
		}

		if (cnf.cache === undefined)
			cnf.cache = {};
		objs.forEach(function (obj) {
			var oldObj = cnf.cache[obj.uuid];
			var newObj = cutServerObj(obj);

			cnf.cache[obj.uuid] = newObj;

			if (!oldObj || newObj.hostname !== oldObj.hostname ||
			    newObj.down !== oldObj.down) {
				self.dripfeeder.push(makeFakeVM(newObj));
			}

			if (oldObj && newObj.down !== oldObj.down) {
				cnf.log.info({
					uuid: obj.uuid,
					newObj: newObj,
					oldObj: oldObj
				}, 'noticed CN status change, polling');
				cnf.pollerStream.start({
					server_uuid: obj.uuid,
					state: 'active'
				});
			}
		});
		S.gotoState('fire');
	}));
	S.timeout(CNAPI_TIMEOUT, function () {
		creq.cancel();
		cnf.log.warn('timed out while updating server cache');
		S.gotoState('retry');
	});
};

UpdateCNCacheFSM.prototype.state_fire = function (S) {
	var waiters = this.waiters;
	var cb;
	this.waiters = [];
	while ((cb = waiters.shift()) !== undefined) {
		cb();
	}
	if (this.waiters.length > 0) {
		S.gotoState('update');
	} else {
		S.gotoState('sleep');
	}
};

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

	this.client = restify.createJsonClient(utils.getRestifyClientOptions({
		url: 'http://' + this.config.address,
		agent: opts.agent
	}));

	this.cache = undefined;

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};

	this.dripfeeder = new DripFeederFSM(this.log, this, FAKECN_MIN_RATE,
	    FAKECN_MAX_RATE);
	this.updater = new UpdateCNCacheFSM(this, this.dripfeeder);

	stream.Transform.call(this, xformOpts);
}
util.inherits(CNFilter, stream.Transform);

CNFilter.prototype.updateServers = function (cb) {
	this.updater.afterUpdate(cb);
};

function genRandomMAC() {
	var hex = crypto.randomBytes(6).toString('hex');
	/* JSSTYLED */
	var mac = hex.replace(/(.{2})(?=.)/g, '$1:');
	return (mac);
}

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
function makeFakeVM(server) {
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
	return (vm);
}

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

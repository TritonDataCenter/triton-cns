/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = UfdsWatcher;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');
var vasync = require('vasync');
var EventEmitter = require('events').EventEmitter;

var consts = require('./consts');

var USER_FIELDS = ['approved_for_provisioning', consts.USER_EN_FLAG];

var cueball = require('cueball');
var ldapjs = require('ldapjs');

function UfdsWatcher(opts) {
	assert.object(opts, 'options');

	assert.object(opts.config, 'options.config');
	assert.object(opts.ufdsPool, 'options.ufdsPool');
	assert.object(opts.pollerStream, 'options.pollerStream');
	assert.object(opts.ufdsCache, 'options.ufdsCache');
	this.ufdsCache = opts.ufdsCache;

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'UfdsWatcher'});

	this.pool = opts.ufdsPool;
	this.pollerStream = opts.pollerStream;
	this.lastSerial = -1;
	this.inCheck = false;

	var self = this;
	this.timer = setInterval(function () {
		self.check();
	}, 5000);
}

UfdsWatcher.prototype.check = function () {
	if (this.inCheck)
		return;
	this.inCheck = true;

	var base = 'cn=changelogcount';
	var opts = {
		scope: 'one',
		filter: new ldapjs.filters.PresenceFilter({
			attribute: 'objectclass'
		})
	};
	var self = this;
	this.pool.claim(function (err, handle, ufds) {
		if (err) {
			self.log.error(err, 'failed to claim UFDS client');
			self.inCheck = false;
			return;
		}

		ufds.search(base, opts, function (err2, res) {
			if (err2) {
				handle.release();
				self.inCheck = false;
				self.log.error(err2, 'UFDS query failed');
				return;
			}

			res.once('searchEntry', function (ent) {
				var es = ent.attributes.filter(function (attr) {
					return (attr.type === 'count');
				});
				assert.strictEqual(es.length, 1);
				var count = es[0].vals[0];
				if (count > self.lastSerial) {
					var last = self.lastSerial;
					self.lastSerial = count;
					self.log.trace('ufds serial now at ' +
					    '%d', count);
					if (last >= 0)
						self.fetch(last);
				}
			});
			res.once('end', function () {
				handle.release();
				self.inCheck = false;
			});
			res.once('error', function (err3) {
				self.log.error(err3, 'UFDS query failed');
				handle.release();
				self.inCheck = false;
			});
		});
	});
};

UfdsWatcher.prototype.fetch = function (serial) {
	var self = this;
	var base = 'cn=changelog';
	var flts = [];
	flts.push(new ldapjs.filters.GreaterThanEqualsFilter({
		attribute: 'changenumber',
		value: serial
	}));
	flts.push(new ldapjs.filters.SubstringFilter({
		attribute: 'targetdn',
		'initial': 'uuid=',
		'final': 'ou=users, o=smartdc'
	}));
	flts.push(new ldapjs.filters.OrFilter({
		filters: [
			new ldapjs.filters.EqualityFilter({
				attribute: 'changetype',
				value: 'add'
			}),
			new ldapjs.filters.EqualityFilter({
				attribute: 'changetype',
				value: 'modify'
			})
		]
	}));
	var opts = {
		scope: 'one',
		filter: new ldapjs.filters.AndFilter({
			filters: flts
		})
	};
	this.pool.claim(function (err, handle, ufds) {
		if (err) {
			self.log.error(err, 'failed to claim UFDS client');
			return;
		}

		ufds.search(base, opts, function (err2, res) {
			if (err2) {
				handle.release();
				self.log.error(err2, 'UFDS query failed');
				return;
			}

			var uuids = {};
			res.on('searchEntry', function (ent) {
				var uuid = processEntry(ent);
				if (uuid !== false)
					uuids[uuid] = true;
			});
			res.once('end', function () {
				handle.release();
				Object.keys(uuids).forEach(function (uuid) {
					var f = {
						state: 'active',
						owner_uuid: uuid
					};
					self.log.info('detected user flag ' +
					    'change on user %s, polling VMs',
					    uuid);
					self.ufdsCache.del(uuid);
					self.pollerStream.start(f);
				});
			});
			res.once('error', function (err3) {
				self.log.error(err3, 'UFDS query failed');
				handle.release();
			});
		});
	});
	function processEntry(ent) {
		var es;

		es = ent.attributes.filter(function (attr) {
			return (attr.type === 'changenumber');
		});
		if (es.length !== 1)
			return (false);
		var n = es[0].vals[0];
		if (typeof (n) === 'string')
			n = parseInt(n, 10);
		if (n == serial)
			return (false);

		es = ent.attributes.filter(function (attr) {
			return (attr.type === 'changes');
		});
		if (es.length !== 1)
			return (false);
		try {
			var changes = JSON.parse(es[0].vals[0]);
		} catch (e) {
			return (false);
		}
		if (Array.isArray(changes)) {
			var cs = changes.filter(function (ch) {
				return (ch.operation === 'replace' &&
				    USER_FIELDS.indexOf(ch.modification.type)
				    !== -1);
			});
			if (cs.length < 1)
				return (false);
		} else {
			var vs = Object.keys(changes).filter(function (k) {
				return (USER_FIELDS.indexOf(k) !== -1);
			});
			if (vs.length < 1)
				return (false);
		}

		es = ent.attributes.filter(function (attr) {
			return (attr.type === 'targetdn');
		});
		if (es.length !== 1)
			return (false);

		var dn = ldapjs.parseDN(es[0].vals[0]);
		var r;

		r = dn.pop();
		assert.strictEqual(r.attrs.o.value, 'smartdc');
		r = dn.pop();
		assert.strictEqual(r.attrs.ou.value, 'users');
		r = dn.pop();

		if (!r.attrs.uuid)
			return (false);
		var uuid = r.attrs.uuid.value;
		if (dn.pop() !== undefined)
			return (false);

		return (uuid);
	}
};

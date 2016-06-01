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
var restify_errors = require('restify-errors');
var querystring = require('querystring');
var ldap = require('ldapjs');

var ResourceNotFoundError = restify_errors.ResourceNotFoundError;

var consts = require('./consts');

function UfdsFilter(opts) {
	assert.object(opts, 'options');

	assert.object(opts.config, 'options.config');
	assert.object(opts.ufdsPool, 'options.ufdsPool');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'UfdsFilter'});

	this.pool = opts.ufdsPool;

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
			self.emit('drop', vm);
			cb();
			return;
		}

		vm.owner = owner;
		vm.timers = vm.timers || [];
		vm.timers.push({t: new Date(), n: 'ufds-filter'});
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

	var base = 'ou=users, o=smartdc';
	var opts = {
		scope: 'one',
		filter: new ldap.filters.EqualityFilter({
			attribute: 'uuid',
			value: uuid
		})
	};

	var self = this;
	this.pool.claim(function (err, handle, ufds) {
		if (err) {
			cb(err);
			return;
		}
		ufds.search(base, opts, function (err2, res) {
			if (err2) {
				handle.release();
				cb(err2);
				return;
			}

			var ents = [];
			res.on('searchEntry', function (ent) {
				ents.push(ent);
			});
			res.once('end', function () {
				handle.release();
				if (ents.length < 1) {
					cb(new ResourceNotFoundError(
					    'User with UUID ' + uuid +
					    ' not found'));
					return;
				}

				assert.strictEqual(ents.length, 1);
				var obj = {};
				ents[0].attributes.forEach(function (attr) {
					var vs = attr.vals;
					if (vs.length === 1)
						vs = vs[0];
					obj[attr.type] = vs;
				});
				self.cache.set(uuid, obj);
				cb(null, obj);
			});
			res.once('error', function (err3) {
				handle.release();
				cb(err3);
			});
		});
	});
};

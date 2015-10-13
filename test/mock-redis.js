/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var minimatch = require('minimatch');

module.exports = MockRedis;

function MockRedis() {
	this.db = {};
}
MockRedis.prototype.keys = function (filter, cb) {
	var keys = Object.keys(this.db).filter(function (k) {
		return (minimatch(k, filter));
	});
	cb(null, keys);
};
MockRedis.prototype.get = function (key, cb) {
	assert.string(key, 'key');
	assert.func(cb, 'callback');
	if (this.db[key] === undefined) {
		cb(null, null);
		return;
	}
	if (typeof (this.db[key]) !== 'string') {
		cb(new TypeError('key is not a string'));
		return;
	}
	cb(null, this.db[key]);
};
MockRedis.prototype.set = function (key, val, cb) {
	assert.string(key, 'key');
	assert.optionalFunc(cb, 'callback');
	assert.string(val, 'value');
	this.db[key] = val;
	cb(null);
};
MockRedis.prototype.hget = function (key, quay, cb) {
	assert.string(key, 'key');
	assert.string(quay, 'quay');
	var val = null;
	if (typeof (this.db[key]) === 'object') {
		if (this.db[key][quay] !== undefined)
			val = this.db[key][quay];
	}
	cb(null, val);
};
MockRedis.prototype.hset = function (key, quay, val, cb) {
	assert.string(key, 'key');
	assert.string(quay, 'quay');
	assert.string(val, 'val');
	assert.optionalFunc(cb, 'callback');

	var v = this.db[key];
	if (v === undefined)
		v = {};
	if (typeof (v) !== 'object') {
		if (cb)
			cb(new TypeError('key is not a hash'));
		return;
	}
	v[quay] = val;
	this.db[key] = v;
	if (cb)
		cb(null);
};
MockRedis.prototype.rpush = function () {
	var args = Array.prototype.slice.call(arguments);
	var key = args.shift();
	assert.string(key, 'key');
	var cb = args.pop();
	if (typeof (cb) !== 'function') {
		assert.string(cb);
		args.push(cb);
		cb = undefined;
	}
	assert.arrayOfString(args);
	var val = this.db[key];
	if (val === undefined)
		val = [];
	if (!Array.isArray(val)) {
		if (cb)
			cb(new TypeError('key is not an array'));
		return;
	}
	val = val.concat(args);
	this.db[key] = val;
	if (cb)
		cb(null);
};

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('./test-namer')('NetFilter');
var sinon = require('sinon');
var util = require('util');

var NetFilter = require('../lib/net-filter');

test('no match', function (t) {
	var config = {
		foo: {
			networks: ['abc123']
		}
	};
	var s = new NetFilter({config: {forward_zones: config}});
	s.write({
		uuid: 'abcd1234',
		nics: [ { network_uuid: '1234aaa' } ]
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.nics[0].zones, []);
	t.end();
});

test('exact uuid match', function (t) {
	var config = {
		foo: {
			networks: ['abc123']
		}
	};
	var s = new NetFilter({config: {forward_zones: config}});
	s.write({
		uuid: 'abcd1234',
		nics: [ { network_uuid: 'abc123' } ]
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.nics[0].zones, ['foo']);
	t.end();
});

test('wilcard match', function (t) {
	var config = {
		foo: {
			networks: ['abc123']
		},
		bar: {
			networks: ['*']
		}
	};
	var s = new NetFilter({config: {forward_zones: config}});
	s.write({
		uuid: 'abcd1234',
		nics: [ { network_uuid: 'abc1234' } ]
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.nics[0].zones, ['bar']);
	t.end();
});

test('wildcard does not match if an exact is present', function (t) {
	var config = {
		foo: {
			networks: ['abc123']
		},
		bar: {
			networks: ['*']
		}
	};
	var s = new NetFilter({config: {forward_zones: config}});
	s.write({
		uuid: 'abcd1234',
		nics: [ { network_uuid: 'abc123' } ]
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.nics[0].zones, ['foo']);
	t.end();
});

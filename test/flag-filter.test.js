/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('./test-namer')('FlagFilter');
var sinon = require('sinon');
var util = require('util');

var FlagFilter = require('../lib/flag-filter');

test('processes a single service tag', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo']);
	t.strictEqual(out.operation, 'add');
	t.end();
});

test('removes from services when CN is down', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'unknown'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.operation, 'add');
	t.end();
});

test('removes from services when metadata flag not up', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {
			'triton.cns.status': 'down'
		},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.operation, 'add');
	t.end();
});

test('adds back into services when metadata flag up', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {
			'triton.cns.status': 'up'
		},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo']);
	t.strictEqual(out.operation, 'add');
	t.end();
});

test('removes all records when user flag is off', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: false,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo']);
	t.strictEqual(out.operation, 'remove');
	t.end();
});

test('removes all records when vm tag is set', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {
			'triton.cns.services': 'foo',
			'triton.cns.disable': 'true'
		}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo']);
	t.strictEqual(out.operation, 'remove');
	t.end();
});

test('removes all records when user is unapproved', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: false
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo']);
	t.strictEqual(out.operation, 'remove');
	t.end();
});

test('removes all records when vm is destroyed', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'destroyed',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: false
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.operation, 'remove');
	s.write({
		uuid: 'abc123',
		destroyed: true,
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: false
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.operation, 'remove');
	t.end();
});

test('parses multiple service tags', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo,bar,test'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo', 'bar', 'test']);
	t.strictEqual(out.operation, 'add');
	t.end();
});

test('parses service tags with future-compatible args', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'running',
		owner: {
			triton_cns_enabled: true,
			approved_for_provisioning: true
		},
		server: {status: 'running'},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo:test=something,bar'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, ['foo', 'bar']);
	t.strictEqual(out.operation, 'add');
	t.end();
});

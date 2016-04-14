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

var FlagFilter = require('../../lib/flag-filter');

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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
	t.end();
});

test('processes an empty tag', function (t) {
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
		tags: {'triton.cns.services': ''}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
	t.end();
});

test('processes an empty sep tag', function (t) {
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
		tags: {'triton.cns.services': ':'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, []);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
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
		server: {status: 'unknown', down: true},
		customer_metadata: {},
		tags: {'triton.cns.services': 'foo'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
	t.end();
});

test('keeps records when PTR tag is set with user flag', function (t) {
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
		tags: {
			'triton.cns.services': 'foo',
			'triton.cns.reverse_ptr': 'foobar.com'
		}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, false);
	t.strictEqual(out.ptrname, 'foobar.com');
	t.end();
});

test('removes all records when ptr is invalid', function (t) {
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
		tags: {
			'triton.cns.services': 'foo',
			'triton.cns.reverse_ptr': '_$%$!!'
		}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
	t.strictEqual(out.hasOwnProperty('ptrname'), false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
	t.end();
});

test('removes all records when vm tag is set even with ptr', function (t) {
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
			'triton.cns.reverse_ptr': 'foobar.com',
			'triton.cns.disable': 'true'
		}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
	t.end();
});

test('removes all records when vm has failed', function (t) {
	var s = new FlagFilter({});
	s.write({
		uuid: 'abc123',
		state: 'failed',
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] } ]);
	t.strictEqual(out.listInstance, false);
	t.strictEqual(out.listServices, false);
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
	t.deepEqual(out.services, [ { name: 'foo', ports: [] },
	    { name: 'bar', ports: [] }, { name: 'test', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
	t.end();
});

test('parses service tags with ports', function (t) {
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
		tags: {'triton.cns.services': 'foo:1234,foo:1235'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [1234, 1235] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
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
		tags: {'triton.cns.services': 'foo:1234:test=something,bar'}
	});
	var out = s.read();
	t.strictEqual(typeof (out), 'object');
	t.deepEqual(out.services, [ { name: 'foo', ports: [1234] },
	    { name: 'bar', ports: [] } ]);
	t.strictEqual(out.listInstance, true);
	t.strictEqual(out.listServices, true);
	t.end();
});

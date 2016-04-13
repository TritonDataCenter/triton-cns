/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('./test-namer')('UpdateStream');
var sinon = require('sinon');
var util = require('util');
var vasync = require('vasync');
var bunyan = require('bunyan');

var UpdateStream = require('../../lib/update-stream');
var MockRedis = require('./mock-redis');

var utils = require('../../lib/utils');

var sandbox;
var currentSerial = 1;

test('setup sandbox', function (t) {
	sandbox = sinon.sandbox.create();
	sandbox.stub(utils, 'nextSerial', function () {
		return (currentSerial + 1);
	});
	sandbox.stub(utils, 'currentSerial', function () {
		return (currentSerial);
	});
	t.equal(utils.currentSerial(), 1);
	t.end();
});

test('writes nothing if given nothing', function (t) {
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {}
	});
	s.openSerial(false);
	s.once('finish', function () {
		s.closeSerial(function () {
			check();
		});
	});
	s.end();

	function check() {
		t.deepEqual(client.db, {});
		t.end();
	}
});

var db;

test('writes records for one container', function (t) {
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [],
		listInstance: true,
		listServices: true,
		reasons: [],
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.4',
				zones: ['foo']
			}
		]
	});
	s.once('finish', function () {
		s.closeSerial(function () {
			db = client.db;
			t.end();
		});
	});
	s.end();
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['abc123.inst.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 2);

	var aRec = instRecs[0];
	var txtRec = instRecs[1];
	if (aRec.constructor !== 'A' && txtRec.constructor === 'A') {
		aRec = instRecs[1];
		txtRec = instRecs[0];
	}

	t.strictEqual(aRec.constructor, 'A');
	t.deepEqual(aRec.args, ['1.2.3.4']);
	t.strictEqual(txtRec.constructor, 'TXT');
	t.deepEqual(txtRec.args, ['abc123']);

	var revRecs = db['zone:3.2.1.in-addr.arpa']['4'];
	revRecs = JSON.parse(revRecs);
	t.strictEqual(revRecs.length, 1);
	t.strictEqual(revRecs[0].constructor, 'PTR');
	t.deepEqual(revRecs[0].args, ['abc123.inst.def432.foo']);

	var vmRecs = db['vm:abc123']['last_recs'];
	t.strictEqual(typeof (vmRecs), 'string');
	vmRecs = JSON.parse(vmRecs);
	t.deepEquals(Object.keys(vmRecs).sort(),
	    ['3.2.1.in-addr.arpa', 'foo']);
	t.deepEquals(Object.keys(vmRecs['foo']).sort(),
	    ['abc123.inst.def432']);
	t.deepEquals(Object.keys(vmRecs['3.2.1.in-addr.arpa']).sort(),
	    ['4']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '2');
	t.deepEqual(db['zone:foo:all'], ['2']);
	t.end();
});

test('deletes records for one container', function (t) {
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [],
		listInstance: true,
		listServices: true,
		reasons: [],
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.4',
				zones: ['foo']
			}
		]
	}, undefined, function () {
		s.closeSerial(function () {
			currentSerial = 2;
			s.write({
				uuid: 'abc123',
				services: [],
				listInstance: false,
				listServices: false,
				reasons: [],
				owner: {
					uuid: 'def432'
				},
				nics: [
					{
						ip: '1.2.3.4',
						zones: ['foo']
					}
				]
			});
			s.once('finish', function () {
				s.closeSerial(function () {
					db = client.db;
					t.end();
				});
			});
			s.end();
		});
	});
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['abc123.inst.def432'];
	instRecs = JSON.parse(instRecs);
	t.deepEqual(instRecs, []);

	var revRecs = db['zone:3.2.1.in-addr.arpa']['4'];
	revRecs = JSON.parse(revRecs);
	t.deepEqual(revRecs, []);

	var vmRecs = db['vm:abc123']['last_recs'];
	t.strictEqual(typeof (vmRecs), 'string');
	vmRecs = JSON.parse(vmRecs);
	t.deepEquals(vmRecs, {});

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '3');
	t.deepEqual(db['zone:foo:all'], ['2', '3']);
	t.end();
});

test('incrementals are correct', function (t) {
	var adds = db['zone:foo:2:3:add'];
	if (Array.isArray(adds)) {
		adds = adds.map(function (r) {
			return (JSON.parse(r));
		});
		t.deepEqual(adds, []);
	} else {
		t.strictEqual(adds, undefined);
	}

	var rems = db['zone:foo:2:3:remove'];
	t.ok(Array.isArray(rems));
	rems = rems.map(function (r) {
		return (JSON.parse(r));
	});
	t.strictEqual(rems.length, 2);
	t.strictEqual(rems[0].name, 'abc123.inst.def432');
	t.strictEqual(rems[1].name, 'abc123.inst.def432');

	t.end();
});

test('updates records upon a change of IP', function (t) {
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	currentSerial = 1;
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [],
		listInstance: true,
		listServices: true,
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.4',
				zones: ['foo']
			}
		]
	}, undefined, function () {
		s.closeSerial(function () {
			currentSerial = 2;
			s.write({
				uuid: 'abc123',
				services: [],
				listInstance: true,
				listServices: true,
				owner: {
					uuid: 'def432'
				},
				nics: [
					{
						ip: '1.2.3.5',
						zones: ['foo']
					}
				]
			});
			s.once('finish', function () {
				s.closeSerial(function () {
					db = client.db;
					t.end();
				});
			});
			s.end();
		});
	});
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['abc123.inst.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 2);

	var aRec = instRecs[0];
	var txtRec = instRecs[1];
	if (aRec.constructor !== 'A' && txtRec.constructor === 'A') {
		aRec = instRecs[1];
		txtRec = instRecs[0];
	}

	t.strictEqual(aRec.constructor, 'A');
	t.deepEqual(aRec.args, ['1.2.3.5']);
	t.strictEqual(txtRec.constructor, 'TXT');
	t.deepEqual(txtRec.args, ['abc123']);

	var revRecs = db['zone:3.2.1.in-addr.arpa']['4'];
	t.strictEqual(revRecs, '[]');
	revRecs = db['zone:3.2.1.in-addr.arpa']['5'];
	revRecs = JSON.parse(revRecs);
	t.strictEqual(revRecs.length, 1);
	t.strictEqual(revRecs[0].constructor, 'PTR');
	t.deepEqual(revRecs[0].args, ['abc123.inst.def432.foo']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '3');
	t.deepEqual(db['zone:foo:all'], ['2', '3']);
	t.end();
});

test('incrementals are generated correctly', function (t) {
	var rmRecs = db['zone:foo:2:3:remove'];
	rmRecs = rmRecs.map(function (r) {
		return (JSON.parse(r));
	});

	t.equal(rmRecs.length, 1);
	var notNamed = rmRecs.filter(function (r) {
		return (r.name !== 'abc123.inst.def432');
	});
	t.equal(notNamed.length, 0);
	var aRec = rmRecs[0].record;
	if (aRec.constructor !== 'A')
		aRec = rmRecs[1].record;
	t.strictEqual(aRec.constructor, 'A');
	t.deepEqual(aRec.args, ['1.2.3.4']);

	var addRecs = db['zone:foo:2:3:add'];
	addRecs = addRecs.map(function (r) {
		return (JSON.parse(r));
	});

	t.equal(addRecs.length, 1);
	notNamed = addRecs.filter(function (r) {
		return (r.name !== 'abc123.inst.def432');
	});
	t.equal(notNamed.length, 0);
	aRec = addRecs[0].record;
	if (aRec.constructor !== 'A')
		aRec = addRecs[1].record;
	t.strictEqual(aRec.constructor, 'A');
	t.deepEqual(aRec.args, ['1.2.3.5']);

	t.end();
});

test('writes records for a service', function (t) {
	currentSerial = 1;
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [ { name: 'bar', ports: [] } ],
		listInstance: true,
		listServices: true,
		reasons: [],
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.4',
				zones: ['foo']
			}
		]
	});
	s.write({
		uuid: 'abcd1234',
		services: [ { name: 'bar', ports: [] } ],
		listInstance: true,
		listServices: true,
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.6',
				zones: ['foo']
			}
		]
	});
	s.once('finish', function () {
		s.closeSerial(function () {
			db = client.db;
			t.end();
		});
	});
	s.end();
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['bar.svc.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 4);

	var aRecs = instRecs.filter(function (r) {
		return (r.constructor === 'A');
	});
	t.equal(aRecs.length, 2);
	var ips = aRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(ips, ['1.2.3.4', '1.2.3.6']);

	var txtRecs = instRecs.filter(function (r) {
		return (r.constructor === 'TXT');
	});
	t.equal(txtRecs.length, 2);
	var uuids = txtRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(uuids, ['abc123', 'abcd1234']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '2');
	t.deepEqual(db['zone:foo:all'], ['2']);
	t.end();
});

test('service with zones with multiple nics', function (t) {
	currentSerial = 1;
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [ { name: 'bar', ports: [] } ],
		listInstance: true,
		listServices: true,
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.4',
				zones: ['foo']
			},
			{
				ip: '2.3.1.2',
				zones: ['foo']
			}
		]
	});
	s.write({
		uuid: 'abcd1234',
		services: [ { name: 'bar', ports: [] } ],
		listInstance: true,
		listServices: true,
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ip: '1.2.3.6',
				zones: ['foo']
			},
			{
				ip: '2.3.1.4',
				zones: ['foo']
			}
		]
	});
	s.once('finish', function () {
		s.closeSerial(function () {
			db = client.db;
			t.end();
		});
	});
	s.end();
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['bar.svc.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 6);

	var aRecs = instRecs.filter(function (r) {
		return (r.constructor === 'A');
	});
	t.equal(aRecs.length, 4);
	var ips = aRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(ips, ['1.2.3.4', '1.2.3.6', '2.3.1.2', '2.3.1.4']);

	var txtRecs = instRecs.filter(function (r) {
		return (r.constructor === 'TXT');
	});
	t.equal(txtRecs.length, 2);
	var uuids = txtRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(uuids, ['abc123', 'abcd1234']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '2');
	t.deepEqual(db['zone:foo:all'], ['2']);
	t.end();
});

test('container with ipv6 addresses', function (t) {
	var client = new MockRedis();
	var s = new UpdateStream({
		client: client,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc123',
		services: [],
		listInstance: true,
		listServices: true,
		owner: {
			uuid: 'def432'
		},
		nics: [
			{
				ips: ['1.2.3.4', 'abcd:f00::1'],
				zones: ['foo']
			}
		]
	});
	s.once('finish', function () {
		s.closeSerial(function () {
			db = client.db;
			t.end();
		});
	});
	s.end();
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['abc123.inst.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 3);

	var aRecs = instRecs.filter(function (r) {
		return (r.constructor === 'A');
	});
	t.equal(aRecs.length, 1);
	var ipv4s = aRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(ipv4s, ['1.2.3.4']);

	var aaRecs = instRecs.filter(function (r) {
		return (r.constructor === 'AAAA');
	});
	t.equal(aaRecs.length, 1);
	var ipv6s = aaRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(ipv6s, ['abcd:f00::1']);

	var txtRecs = instRecs.filter(function (r) {
		return (r.constructor === 'TXT');
	});
	t.equal(txtRecs.length, 1);
	var uuids = txtRecs.map(function (r) {
		return (r.args[0]);
	}).sort();
	t.deepEqual(uuids, ['abc123']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '2');
	t.deepEqual(db['zone:foo:all'], ['2']);
	t.end();
});

test('add, delete-add race against commit', function (t) {
	var client = new MockRedis();
	var log = bunyan.createLogger({name: 'race-test', level: 'debug'});
	var s = new UpdateStream({
		client: client,
		log: log,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	vasync.pipeline({
		funcs: [
			function (_, cb) {
				currentSerial = 1;
				s.openSerial(false);
				s.write({
					uuid: 'abc123',
					services: [],
					listInstance: true,
					listServices: true,
					owner: {
						uuid: 'def432'
					},
					nics: [
						{
							ip: '1.2.3.4',
							zones: ['foo']
						}
					]
				}, undefined, cb);
			},
			function (_, cb) {
				s.write({
					uuid: 'abc123',
					services: [],
					listInstance: true,
					listServices: true,
					owner: {
						uuid: 'def432'
					},
					nics: [
						{
							ip: '1.2.3.4',
							zones: ['foo']
						}
					]
				}, undefined, cb);
			},
			function (_, cb) {
				s.closeSerial(cb);
			},
			function (_, cb) {
				currentSerial = 2;
				s.openSerial(false);
				setTimeout(function () {
					s.closeSerial(cb);
				}, 100);
			},
			function (_, cb) {
				currentSerial = 3;
				s.openSerial(false);
				s.write({
					uuid: 'abc123',
					services: [],
					listInstance: false,
					listServices: false,
					owner: {
						uuid: 'def432'
					},
					nics: [
						{
							ip: '1.2.3.4',
							zones: ['foo']
						}
					]
				}, undefined, cb);
			},
			function (_, cb) {
				s.once('finish', cb);
				s.write({
					uuid: 'abc123',
					services: [],
					listInstance: true,
					listServices: true,
					owner: {
						uuid: 'def432'
					},
					nics: [
						{
							ip: '1.2.3.4',
							zones: ['foo']
						}
					]
				}, undefined, function () {
					s.end();
				});
				s.closeSerial(function () {
					currentSerial = 4;
					s.emit('_test_commit_done');
				});
			},
			function (_, cb) {
				if (currentSerial === 4)
					cb();
				else
					s.once('_test_commit_done', cb);
			},
			function (_, cb) {
				s.openSerial(false);
				setTimeout(function () {
					s.closeSerial(cb);
				}, 100);
			}
		]
	}, function (err, res) {
		db = client.db;
		t.end();
	});
});

test('records in zones are correct', function (t) {
	var instRecs = db['zone:foo']['abc123.inst.def432'];
	instRecs = JSON.parse(instRecs);
	t.strictEqual(instRecs.length, 2);

	var aRec = instRecs[0];
	var txtRec = instRecs[1];
	if (aRec.constructor !== 'A' && txtRec.constructor === 'A') {
		aRec = instRecs[1];
		txtRec = instRecs[0];
	}

	t.strictEqual(aRec.constructor, 'A');
	t.deepEqual(aRec.args, ['1.2.3.4']);
	t.strictEqual(txtRec.constructor, 'TXT');
	t.deepEqual(txtRec.args, ['abc123']);

	var revRecs = db['zone:3.2.1.in-addr.arpa']['4'];
	revRecs = JSON.parse(revRecs);
	t.strictEqual(revRecs.length, 1);
	t.strictEqual(revRecs[0].constructor, 'PTR');
	t.deepEqual(revRecs[0].args, ['abc123.inst.def432.foo']);

	var vmRecs = db['vm:abc123']['last_recs'];
	t.strictEqual(typeof (vmRecs), 'string');
	vmRecs = JSON.parse(vmRecs);
	t.deepEquals(Object.keys(vmRecs).sort(),
	    ['3.2.1.in-addr.arpa', 'foo']);
	t.deepEquals(Object.keys(vmRecs['foo']).sort(),
	    ['abc123.inst.def432']);
	t.deepEquals(Object.keys(vmRecs['3.2.1.in-addr.arpa']).sort(),
	    ['4']);

	t.end();
});

test('serial numbers are correct', function (t) {
	t.strictEqual(db['zone:foo:latest'], '4');
	t.deepEqual(db['zone:foo:all'], ['2', '4']);
	t.end();
});

test('cleanup sandbox', function (t) {
	sandbox.restore();
	t.end();
});

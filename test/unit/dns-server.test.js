/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('tape').test;
var sinon = require('sinon');
var util = require('util');
var dns = require('native-dns');

var UpdateStream = require('../../lib/update-stream');
var DNSServer = require('../../lib/dns-server');
var MockRedis = require('./mock-redis');

var utils = require('../../lib/utils');

var sandbox;
var redis;
var server;
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
	redis = new MockRedis();
	t.end();
});

test('create basic dataset', function (t) {
	var s = new UpdateStream({
		client: redis,
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
				ip: '1.2.3.4',
				zones: ['foo']
			}
		]
	});
	s.once('finish', function () {
		s.closeSerial(function () {
			t.end();
		});
	});
	s.end();
});

test('create server', function (t) {
	server = new DNSServer({
		client: redis,
		port: 9953,
		address: '127.0.0.1',
		config: {
			my_name: 'foobar',
			hostmaster: 'root@foobar',
			reverse_zones: {},
			forward_zones: {
				'foo': {
					networks: ['*']
				}
			}
		}
	});
	server.once('listening', function () {
		t.end();
	});
});

test('returns SERVFAIL/ESERVER for qs outside zones', function (t) {
	var q = dns.Question({
		name: 'foo.com',
		type: 'SOA'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.header.rcode,
		    dns.consts.NAME_TO_RCODE['SERVFAIL']);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves zone SOA', function (t) {
	var q = dns.Question({
		name: 'foo',
		type: 'SOA'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.header.rcode,
		    dns.consts.NAME_TO_RCODE['NOERROR']);
		t.equal(answer.answer.length, 1);
		var soa = answer.answer[0];
		t.strictEqual(soa.name, 'foo');
		t.equal(soa.ttl, 30);
		t.strictEqual(soa.primary, 'foobar');
		t.strictEqual(soa.admin, 'root.foobar');
		t.equal(soa.serial, 2);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves instance A records', function (t) {
	var q = dns.Question({
		name: 'abc123.inst.def432.foo',
		type: 'A'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 1);
		t.equal(answer.answer[0].ttl, 30);
		t.strictEqual(answer.answer[0].address, '1.2.3.4');
		t.equal(answer.authority.length, 1);
		t.equal(answer.authority[0].type,
		    dns.consts.NAME_TO_QTYPE['NS']);
		t.strictEqual(answer.authority[0].name, 'foo');
		t.strictEqual(answer.authority[0].data, 'foobar');
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves instance TXT records', function (t) {
	var q = dns.Question({
		name: 'abc123.inst.def432.foo',
		type: 'TXT'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 1);
		t.deepEqual(answer.answer[0].data, ['abc123']);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('generate some services', function (t) {
	++currentSerial;

	var s = new UpdateStream({
		client: redis,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc1',
		services: [ { name: 'test', ports: [] } ],
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
	s.write({
		uuid: 'abc2',
		services: [ { name: 'test', ports: [] } ],
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
			t.end();
		});
	});
	s.end();
});

test('serves zone SOA', function (t) {
	var q = dns.Question({
		name: 'foo',
		type: 'SOA'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.header.rcode,
		    dns.consts.NAME_TO_RCODE['NOERROR']);
		t.equal(answer.answer.length, 1);
		var soa = answer.answer[0];
		t.strictEqual(soa.name, 'foo');
		t.equal(soa.serial, 3);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves service A records', function (t) {
	var q = dns.Question({
		name: 'test.svc.def432.foo',
		type: 'A'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 2);
		var ttls = answer.answer.map(function (a) {
			return (a.ttl);
		});
		t.deepEqual(ttls, [30, 30]);
		var addrs = answer.answer.map(function (a) {
			return (a.address);
		}).sort();
		t.deepEqual(addrs, ['1.2.3.5', '1.2.3.6']);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves service TXT records', function (t) {
	var q = dns.Question({
		name: 'test.svc.def432.foo',
		type: 'TXT'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 2);
		var ttls = answer.answer.map(function (a) {
			return (a.ttl);
		});
		t.deepEqual(ttls, [30, 30]);
		var datas = answer.answer.map(function (a) {
			return (a.data);
		}).sort();
		t.deepEqual(datas, [ [ 'abc1' ], [ 'abc2' ] ]);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('services with ports (SRV)', function (t) {
	++currentSerial;

	var s = new UpdateStream({
		client: redis,
		config: {
			forward_zones: {
				'foo': {}
			},
			reverse_zones: {}
		}
	});
	s.openSerial(false);
	s.write({
		uuid: 'abc1',
		services: [ { name: 'test', ports: [1234] } ],
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
	s.write({
		uuid: 'abc2',
		services: [ { name: 'test', ports: [1234, 1235] } ],
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
			t.end();
		});
	});
	s.end();
});

test('serves zone SOA', function (t) {
	var q = dns.Question({
		name: 'foo',
		type: 'SOA'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.header.rcode,
		    dns.consts.NAME_TO_RCODE['NOERROR']);
		t.equal(answer.answer.length, 1);
		var soa = answer.answer[0];
		t.strictEqual(soa.name, 'foo');
		t.equal(soa.serial, 4);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves service A records', function (t) {
	var q = dns.Question({
		name: 'test.svc.def432.foo',
		type: 'A'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 2);
		var ttls = answer.answer.map(function (a) {
			return (a.ttl);
		});
		t.deepEqual(ttls, [30, 30]);
		var addrs = answer.answer.map(function (a) {
			return (a.address);
		}).sort();
		t.deepEqual(addrs, ['1.2.3.5', '1.2.3.6']);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('serves service SRV records', function (t) {
	var q = dns.Question({
		name: 'test.svc.def432.foo',
		type: 'SRV'
	});
	var req = dns.Request({
		question: q,
		server: { address: '127.0.0.1', port: 9953, type: 'udp' },
		timeout: 1000
	});
	req.once('timeout', function () {
		t.fail('timeout');
		t.end();
	});
	req.on('message', function (err, answer) {
		t.error(err);
		t.equal(answer.answer.length, 3);
		var ttls = answer.answer.map(function (a) {
			return (a.ttl);
		});
		t.deepEqual(ttls, [30, 30, 30]);
		var recs = answer.answer.map(function (a) {
			return ({target: a.target, port: a.port});
		}).sort();
		t.deepEqual(recs, [
		    {target: 'abc1.inst.def432.foo', port: 1234},
		    {target: 'abc2.inst.def432.foo', port: 1234},
		    {target: 'abc2.inst.def432.foo', port: 1235}]);
		var addns = answer.additional.map(function (a) {
			return ({name: a.name, address: a.address});
		}).sort();
		t.deepEqual(addns, [
		    {name: 'abc1.inst.def432.foo', address: '1.2.3.5'},
		    {name: 'abc2.inst.def432.foo', address: '1.2.3.6'}
		]);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

test('cleanup sandbox', function (t) {
	server.close();
	sandbox.restore();
	t.end();
});

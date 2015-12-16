/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var tape = require('tape');
var test = tape.test;

var spawn = require('child_process').spawn;
var restify = require('restify-clients');
var fs = require('fs');
var jsprim = require('jsprim');
var dns = require('native-dns');

var zonename = process.env['ZONENAME'];
var sapi = restify.createJsonClient({
	url: process.env['SAPI_URL']
});

var serviceUuid;
var instanceUuid;
var config;
var schema;
var zone;

test('locate CNS instance', function (t) {
	sapi.get('/services?name=cns', function (err, req, res, objs) {
		t.error(err);
		t.ok(Array.isArray(objs));
		t.strictEqual(objs.length, 1);
		serviceUuid = objs[0].uuid;
		sapi.get('/instances?service_uuid=' + serviceUuid,
		    function (err, req, res, objs) {
			t.error(err);
			t.ok(Array.isArray(objs));
			t.strictEqual(objs.length, 1);
			instanceUuid = objs[0].uuid;
			t.end();
		});
	});
});

test('fetch CNS config', function (t) {
	var path = '/opt/triton/cns/lib/config-schema.json';
	if (zonename === 'global')
		path = '/zones/' + instanceUuid + '/root' + path;
	schema = JSON.parse(fs.readFileSync(path).toString('utf-8'));

	path = '/opt/triton/cns/etc/config.json';
	if (zonename === 'global')
		path = '/zones/' + instanceUuid + '/root' + path;
	config = JSON.parse(fs.readFileSync(path).toString('utf-8'));

	var verr = jsprim.validateJsonObject(schema, config);
	t.error(verr);

	t.ok(Object.keys(config.forward_zones).length > 0);
	var zs = Object.keys(config.forward_zones).filter(function (z) {
		return (config.forward_zones[z].networks.indexOf('*') !== -1);
	});
	t.ok(zs.length > 0);
	zone = zs[0];
	console.log('# using zone "%s" for tests', zone);

	t.end();
});

test('DNS server is alive', function (t) {
	var q = dns.Question({
		name: zone,
		type: 'SOA'
	});
	var req = dns.Request({
		question: q,
		server: { address: process.env['CNS_HOST'], type: 'udp' },
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
		console.log('# zone is at serial %d', answer.answer[0].serial);
	});
	req.once('end', function () {
		t.end();
	});
	req.send();
});

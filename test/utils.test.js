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

var utils = require('../lib/utils');

test('currentSerial', function (t) {
	var sandbox;
	var OldDate = Date;
	var fixedDate = new Date('2015-10-01T03:24:00Z');

	function MockDate() {
	}
	MockDate.prototype.getYear =
	    function () { return (fixedDate.getYear()); };
	MockDate.prototype.getMonth =
	    function () { return (fixedDate.getMonth()); };
	MockDate.prototype.getDate =
	    function () { return (fixedDate.getDate()); };
	MockDate.prototype.getHours =
	    function () { return (fixedDate.getHours()); };
	MockDate.prototype.getMinutes =
	    function () { return (fixedDate.getMinutes()); };
	MockDate.prototype.getSeconds =
	    function () { return (fixedDate.getSeconds()); };

	t.test('setup sandbox', function (tt) {
		sandbox = sinon.sandbox.create();
		sandbox.stub(global, 'Date', MockDate);
		tt.end();
	});
	t.test('currentSerial returns the correct serial', function (tt) {
		var s = utils.currentSerial();
		tt.strictEqual(s, 372019824);
		tt.end();
	});
	t.test('currentSerial increments every 10 secs', function (tt) {
		fixedDate.setSeconds(4);
		tt.strictEqual(utils.currentSerial(), 372019824);
		fixedDate.setSeconds(11);
		tt.strictEqual(utils.currentSerial(), 372019825);
		tt.end();
	});
	t.test('cleanup sandbox', function (tt) {
		sandbox.restore();
		tt.end();
	});
	t.end();
});

test('reverseZoneIp for ipv4', function (t) {
	var ret = utils.reverseZoneIp('12.13.14.15');
	t.strictEqual(typeof (ret), 'object');
	t.strictEqual(ret.name, '15');
	t.strictEqual(ret.zone, '14.13.12.in-addr.arpa');
	t.end();
});

test('reverseZoneIp for ipv6', function (t) {
	var ret = utils.reverseZoneIp('2607:abcd:1234:defa::1');
	t.strictEqual(typeof (ret), 'object');
	t.strictEqual(ret.name, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0');
	t.strictEqual(ret.zone, 'a.f.e.d.4.3.2.1.d.c.b.a.7.0.6.2.ip6.arpa');
	t.end();
});

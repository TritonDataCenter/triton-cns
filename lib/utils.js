/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = {
	currentSerial: currentSerial,
	nextSerial: nextSerial,
	reverseZoneIp: reverseZoneIp
};

var ipaddr = require('ipaddr.js');

function currentSerial() {
	var now = new Date();
	var serial = now.getYear();
	serial = serial * 12 + now.getMonth();
	serial = serial * 31 + now.getDate() - 1;
	serial = serial * 24 + now.getHours();
	serial = serial * 60 + now.getMinutes();
	serial = serial * 6 + Math.floor(now.getSeconds() / 10);
	return (serial);
}

function nextSerial() {
	return (currentSerial() + 1);
}

function reverseZoneIp(ip) {
	var address, kind, parts, name, zone;
	address = ipaddr.parse(ip);
	kind = address.kind();

	switch (kind) {
	case 'ipv4':
		address = address.toByteArray();
		address.reverse();
		name = String(address.shift());
		zone = address.join('.') + '.in-addr.arpa';
		return ({name: name, zone: zone});
	case 'ipv6':
		parts = [];
		address.toNormalizedString().split(':').
		    forEach(function (part) {
			var i, pad = 4 - part.length;
			for (i = 0; i < pad; i++) {
				part = '0' + part;
			}
			part.split('').forEach(function (p) {
				parts.push(p);
			});
		});
		parts.reverse();
		name = parts.slice(0, 16).join('.');
		zone = parts.slice(16).join('.') + '.ip6.arpa';
		return ({name: name, zone: zone});
	default:
		throw (new Error('Unknown address kind: ' + kind));
	}
}

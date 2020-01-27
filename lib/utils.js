/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright 2020 Joyent, Inc.
 */

module.exports = {
	currentSerial: currentSerial,
	lowerCaseAllKeys: lowerCaseAllKeys,
	nextSerial: nextSerial,
	reverseZoneIp: reverseZoneIp,
	recSetMatch: recSetMatch,
	recSetDiff: recSetDiff,
	recMatch: recMatch,
	cleanVM: cleanVM,
	getRestifyClientOptions: getRestifyClientOptions
};

var assert = require('assert-plus');
var ipaddr = require('ipaddr.js');
var jsprim = require('jsprim');

function currentSerial() {
	var now = new Date();
	var serial = now.getUTCFullYear() - 1900;
	serial = serial * 12 + now.getUTCMonth();
	serial = serial * 31 + now.getUTCDate() - 1;
	serial = serial * 24 + now.getUTCHours();
	serial = serial * 60 + now.getUTCMinutes();
	serial = serial * 6 + Math.floor(now.getUTCSeconds() / 10);
	return (serial);
}

function serialToDate(serial) {
	var secs = (serial % 6) * 10;
	serial /= 6;
	var min = (serial % 60);
	serial /= 60;
	var hour = (serial % 24);
	serial /= 24;
	var day = (serial % 31) + 1;
	serial /= 31;
	var month = (serial % 12);
	var year = 1900 + serial / 12;
	return (new Date(Date.UTC(year, month, day, hour, min, secs)));
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

function recSetDiff(set1, set2) {
	set1 = set1.slice();
	set2 = set2.slice();
	var rm = [];
	var add = [];
	for (var i = 0; i < set1.length; ++i) {
		if (set1[i] === null)
			continue;

		var found = false;
		for (var j = 0; j < set2.length; ++j) {
			if (set2[j] === null)
				continue;

			if (recMatch(set1[i], set2[j])) {
				found = true;
				set2[j] = null;
				set1[i] = null;
				break;
			}
		}
		if (!found)
			rm.push(set1[i]);
	}

	for (j = 0; j < set2.length; ++j) {
		if (set2[j] === null)
			continue;

		found = false;
		for (i = 0; i < set1.length; ++i) {
			if (set1[i] === null)
				continue;

			if (recMatch(set2[j], set1[i])) {
				found = true;
				set2[j] = null;
				set1[i] = null;
				break;
			}
		}
		if (!found)
			add.push(set2[j]);
	}

	return ({add: add, remove: rm});
}

function recSetMatch(set1, set2) {
	if (set1.length !== set2.length)
		return (false);

	for (var i = 0; i < set1.length; ++i) {
		var found = false;
		for (var j = 0; j < set2.length; ++j) {
			if (recMatch(set1[i], set2[j])) {
				found = true;
				break;
			}
		}
		if (!found)
			return (false);
	}
	return (true);
}

function recMatch(rec1, rec2) {
	return ((rec1.id && rec2.id && rec1.id === rec2.id) || (
	    (rec1.constructor === rec2.constructor) &&
	    (JSON.stringify(rec1.args) === JSON.stringify(rec2.args))));
}

function cleanVM(obj) {
	/* Delete some attribs that can get pretty big. */
	delete (obj.customer_metadata['user-script']);
	delete (obj.customer_metadata['root_authorized_keys']);
	delete (obj.datasets);
	delete (obj.resolvers);
	delete (obj.zfs_filesystem);
	delete (obj.zonepath);
	delete (obj.filesystems);
	delete (obj.internal_metadata);

	Object.keys(obj).filter(function (k) {
		return (k.slice(0, 4) === 'max_' ||
		    k.slice(0, 4) === 'cpu_');
	}).forEach(function (k) {
		delete (obj[k]);
	});

	obj.timers = [];
	obj.timers.push({t: new Date(), n: 'cleanVM'});
}

/*
 * Merge the given restify client options with a set of default restify options.
 *
 * @param {Object} opts - restify client options.
 * @returns New object containing the merged restify client options.
 */
function getRestifyClientOptions(opts) {
	var newOpts = jsprim.deepCopy(opts);

	// TRITON-630 When calculating the response content-md5 hash, use both
	// 'utf8' and 'binary' encodings in order to support node v4 (and
	// before) talking to node v6 (and higher).
	if (!newOpts.contentMd5) {
		newOpts.contentMd5 = {encodings: ['utf8', 'binary']};
	}

	return (newOpts);
}

/*
 * Convert the top level key names to lower case.
 *
 * @param {Object} with key names in mixed case
 * @returns Object with all lower case keys
 */
function lowerCaseAllKeys(o) {
	var keys = Object.keys(o);
	var new_o = {};

	assert.object(o);
	assert.arrayOfString(keys);

	keys.forEach(function (key) {
		var l_key = key.toLowerCase();
		new_o[l_key] = o[key];
	});
	return (new_o);
}

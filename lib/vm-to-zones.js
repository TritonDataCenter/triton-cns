/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = buildZonesFromVm;

var util = require('util');
var utils = require('./utils');
var assert = require('assert-plus');
var consts = require('./consts');
var net = require('net');

/*
 * Turn a complete VM record (after having been passed through FlagFilter,
 * NetFilter, CNFilter etc) into an object representing all of the DNS records
 * that this VM should result in.
 */
function buildZonesFromVm(vm, config, log) {
	var entries = [];
	vm.nics.forEach(function (nic) {
		if (nic.ips === undefined)
			nic.ips = [nic.ip];
		nic.ips.forEach(function (ipmask) {
			var ip = ipmask.split('/')[0];
			assert.arrayOfString(nic.zones, 'vm.nics.zones');
			nic.zones.forEach(function (zone) {
				if (vm.listInstance) {
					entries.push({
						type: 'instance',
						ip: ip,
						zone: zone
					});
				}
				if (vm.listServices) {
					vm.services.forEach(function (svc) {
						entries.push({
							type: 'service',
							ip: ip,
							zone: zone,
							service: svc
						});
					});
				}
			});
		});
	});

	/*
	 * Build the full set of records in zones that this VM should be
	 * responsible for. This is the set we want to get to.
	 */
	var zones = {};
	entries.forEach(function (ent) {
		var addrType;
		if (net.isIPv4(ent.ip)) {
			addrType = 'A';
		} else if (net.isIPv6(ent.ip)) {
			addrType = 'AAAA';
		} else if (ent.ip === 'dhcp' || ent.ip === 'addrconf') {
			log.trace({entry: ent},
			    'skipping this entry, no fixed IP');
			return;
		} else {
			throw (new Error('Unknown address type: ' + ent.ip));
		}
		ent.addrType = addrType;

		if (!zones[ent.zone])
			zones[ent.zone] = {};

		if (ent.type === 'instance') {
			addInstance(zones, vm, ent, config);
		} else if (ent.type === 'service') {
			addService(zones, vm, ent, config);
		}
	});

	return (zones);
}

function dnsify(str) {
	return (str.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
}

function primaryName(vm, config) {
	if (vm.primaryName)
		return (vm.primaryName);
	var n = vm.uuid + '.inst.' + vm.owner.uuid;
	if (config.use_login && vm.owner.login.length < 63) {
		n = vm.uuid + '.inst.' + dnsify(vm.owner.login);
	}

	if (config.use_alias && vm.alias && vm.alias.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + vm.owner.uuid;
	}

	if (config.use_login && config.use_alias && vm.alias &&
	    vm.alias.length < 63 && vm.owner.login.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + dnsify(vm.owner.login);
	}

	return ((vm.primaryName = n));
}

function addInstance(zones, vm, ent, config) {
	function addName(name) {
		if (!zones[ent.zone])
			zones[ent.zone] = {};
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		recs.push({
			constructor: ent.addrType,
			args: [ent.ip]
		});
		var hasTxt = false;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].constructor === 'TXT') {
				hasTxt = true;
				assert.strictEqual(recs[i].args[0], vm.uuid);
				break;
			}
		}
		if (!hasTxt) {
			recs.push({
				constructor: 'TXT',
				args: [vm.uuid]
			});
		}
	}

	var revName = primaryName(vm, config);

	var n = vm.uuid + '.inst.' + vm.owner.uuid;
	addName(n);

	if (config.use_login && vm.owner.login.length < 63) {
		addName(vm.uuid + '.inst.' + dnsify(vm.owner.login));
	}

	if (config.use_alias && vm.alias && vm.alias.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + vm.owner.uuid;
		addName(n);
	}

	if (config.use_login && config.use_alias && vm.alias &&
	    vm.alias.length < 63 && vm.owner.login.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + dnsify(vm.owner.login);
		addName(n);
	}

	revName = revName + '.' + ent.zone;
	if (vm.ptrname)
		revName = vm.ptrname;

	var rev = utils.reverseZoneIp(ent.ip);
	if (!zones[rev.zone])
		zones[rev.zone] = {};
	var revs = zones[rev.zone][rev.name];
	if (!revs || revs[0].args[0].length > revName.length) {
		zones[rev.zone][rev.name] = [ {
			constructor: 'PTR',
			args: [revName]
		} ];
	}
}

function addService(zones, vm, ent, config) {
	var svc = ent.service;
	function addName(name) {
		if (!zones[ent.zone])
			zones[ent.zone] = {};
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		recs.push({
			constructor: ent.addrType,
			args: [ent.ip],
			src: vm.uuid
		});
		var hasTxt = false;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].constructor === 'TXT' &&
			    recs[i].args[0] === vm.uuid) {
				hasTxt = true;
				break;
			}
		}
		if (!hasTxt) {
			recs.push({
				constructor: 'TXT',
				args: [vm.uuid],
				src: vm.uuid
			});
		}
	}
	function addSRV(name, port) {
		if (!zones[ent.zone])
			zones[ent.zone] = {};
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		var target = primaryName(vm, config) + '.' + ent.zone;
		recs.push({
			constructor: 'SRV',
			args: [target, port],
			src: vm.uuid
		});
	}
	addName(svc.name + '.svc.' + vm.owner.uuid);
	svc.ports.forEach(function (port) {
		addSRV(svc.name + '.svc.' + vm.owner.uuid, port);
	});
	if (config.use_login && vm.owner.login.length < 63) {
		addName(svc.name + '.svc.' + dnsify(vm.owner.login));
		svc.ports.forEach(function (port) {
			addSRV(
			    svc.name + '.svc.' + dnsify(vm.owner.login), port);
		});
	}
}

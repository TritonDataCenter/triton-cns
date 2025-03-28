/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 * Copyright 2016, 2020, The University of Queensland
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
						zone: zone,
						network: nic.network,
						network_pools: nic.network_pools
					});
				}
				vm.services.forEach(function (svc) {
					entries.push({
						type: 'service',
						ip: ip,
						zone: zone,
						service: svc,
						network: nic.network,
						network_pools: nic.network_pools
					});
				});
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

	/*
	 * Add the CMON CNAME records. These exist in all DNS zones, no
	 * matter what interfaces a VM has.
	 */
	Object.keys(config.forward_zones).forEach(function (z) {
		var name = vm.uuid + '.cmon';
		var target = 'cmon.' + z;
		if (!zones[z])
			zones[z] = {};
		if (!zones[z][name])
			zones[z][name] = [];
		var recs = zones[z][name];
		recs.push({
			constructor: 'CNAME',
			args: [target]
		});
	});

	return (zones);
}

function dnsify(str) {
	return (str.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
}

function getSuffixes(vm, config) {
	var res = [];

	vm.nics.forEach(function (nic) {
		nic.zones.forEach(function (zone) {
			var n = vm.owner.uuid + '.' + zone;
			if (config.use_login)
				n = dnsify(vm.owner.login) + '.' + zone;
			if (res.indexOf('svc.' + n) === -1) {
				res.push('svc.' + n);
				res.push('inst.' + n);
			}
		});
	});

	return (res);
}
buildZonesFromVm.getSuffixes = getSuffixes;

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

function isWildcard(config, zone) {
	return (config.forward_zones[zone].networks.indexOf('*') !== -1);
}

function isNetOwned(vm, netw) {
	return ((netw.owner_uuids || []).indexOf(vm.owner.uuid) !== -1);
}

function isProxied(ent, config) {
	var zoneConfig = config.forward_zones[ent.zone];
	if (!zoneConfig.proxy_networks)
		return (false);
	if (zoneConfig.proxy_networks.indexOf(ent.network.uuid) !== -1)
		return (true);
	if (zoneConfig.proxy_networks.indexOf('*') !== -1)
		return (true);
	var pools = ent.network_pools;
	if (!pools)
		return (false);
	for (var i = 0; i < pools.length; ++i) {
		if (zoneConfig.proxy_networks.indexOf(pools[i]) !== -1)
			return (true);
	}
	return (false);
}

function addInstance(zones, vm, ent, config) {
	function addName(name) {
		if (!zones[ent.zone])
			zones[ent.zone] = {};
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		var ip = ent.ip;
		if (isProxied(ent, config))
			ip = config.forward_zones[ent.zone].proxy_addr;
		recs.push({
			constructor: ent.addrType,
			args: [ip]
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

	function addACME(name) {
		if (vm.customer_metadata === undefined)
			return;
		var chal = vm.customer_metadata[consts.INST_ACME_KEY];
		if (chal !== undefined) {
			name = '_acme-challenge.' + name;
			if (!zones[ent.zone])
				zones[ent.zone] = {};
			if (!zones[ent.zone][name])
				zones[ent.zone][name] = [];
			var recs = zones[ent.zone][name];
			chal.split(' ').forEach(function (c) {
				recs.push({
					constructor: 'TXT',
					args: [c]
				});
			});
		}
	}

	var revName = primaryName(vm, config);

	var n = vm.uuid + '.inst.' + vm.owner.uuid;
	addName(n);
	addACME(n);

	var doNetworkName = (isWildcard(config, ent.zone) &&
	    isNetOwned(vm, ent.network));

	if (doNetworkName) {
		n = dnsify(ent.network.name) + '.' + n;
		addName(n);
		addACME(n);
	}

	if (config.use_login && vm.owner.login.length < 63) {
		n = vm.uuid + '.inst.' + dnsify(vm.owner.login);
		addName(n);
		addACME(n);

		if (doNetworkName) {
			n = dnsify(ent.network.name) + '.' + n;
			addName(n);
			addACME(n);
		}
	}

	if (config.use_alias && vm.alias && vm.alias.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + vm.owner.uuid;
		addName(n);
		addACME(n);

		if (doNetworkName) {
			n = dnsify(ent.network.name) + '.' + n;
			addName(n);
			addACME(n);
		}
	}

	if (config.use_login && config.use_alias && vm.alias &&
	    vm.alias.length < 63 && vm.owner.login.length < 63) {
		n = dnsify(vm.alias) + '.inst.' + dnsify(vm.owner.login);
		addName(n);
		addACME(n);

		if (doNetworkName) {
			n = dnsify(ent.network.name) + '.' + n;
			addName(n);
			addACME(n);
		}
	}

	revName = revName + '.' + ent.zone;
	if (vm.ptrname)
		revName = vm.ptrname;

	if (!isProxied(ent, config)) {
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
}

function addService(zones, vm, ent, config) {
	var svc = ent.service;
	function addName(name) {
		if (!zones[ent.zone])
			zones[ent.zone] = {};
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		var ip = ent.ip;
		if (isProxied(ent, config))
			ip = config.forward_zones[ent.zone].proxy_addr;
		var hasTxt = false;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].constructor === 'TXT' &&
			    recs[i].args[0].indexOf(vm.uuid) !== -1) {
				hasTxt = true;
				break;
			}
		}
		if (vm.listServices) {
			recs.push({
				constructor: ent.addrType,
				args: [ip],
				src: vm.uuid
			});
			if (!hasTxt) {
				recs.push({
					constructor: 'TXT',
					args: [vm.uuid],
					src: vm.uuid
				});
			}
		} else if (!hasTxt) {
			recs.push({
				constructor: 'TXT',
				args: ['verifying:' + vm.uuid],
				src: vm.uuid
			});
		}
	}
	function addSRV(name, port) {
		if (vm.listServices) {
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
	}

	function addACME(name) {
		if (vm.customer_metadata === undefined)
			return;
		var chal = vm.customer_metadata[consts.INST_ACME_KEY];
		if (chal !== undefined) {
			name = '_acme-challenge.' + name;
			if (!zones[ent.zone])
				zones[ent.zone] = {};
			if (!zones[ent.zone][name])
				zones[ent.zone][name] = [];
			var recs = zones[ent.zone][name];
			chal.split(' ').forEach(function (c) {
				recs.push({
					constructor: 'TXT',
					args: [c],
					src: vm.uuid
				});
			});
		}
	}

	var doNetworkName = (isWildcard(config, ent.zone) &&
	    isNetOwned(vm, ent.network));

	var n = svc.name + '.svc.' + vm.owner.uuid;
	addName(n);
	addACME(n);
	if (vm.owner.login === 'admin') {
		addName(svc.name);
		addACME(svc.name);
	}
	svc.ports.forEach(function (port) {
		addSRV(n, port);
	});

	if (doNetworkName) {
		n = dnsify(ent.network.name) + '.' + n;
		addName(n);
		addACME(n);
		svc.ports.forEach(function (port) {
			addSRV(n, port);
		});
	}

	if (config.use_login && vm.owner.login.length < 63) {
		n = svc.name + '.svc.' + dnsify(vm.owner.login);
		addName(n);
		addACME(n);
		svc.ports.forEach(function (port) {
			addSRV(n, port);
		});

		if (doNetworkName) {
			n = dnsify(ent.network.name) + '.' + n;
			addName(n);
			addACME(n);
			svc.ports.forEach(function (port) {
				addSRV(n, port);
			});
		}
	}
}

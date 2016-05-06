/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = DNSServer;

var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var named = require('named');
var EventEmitter = require('events').EventEmitter;
var sprintf = util.format;
var vasync = require('vasync');
var ipaddr = require('ipaddr.js');
var dns = require('dns');
var crypto = require('crypto');
var dgram = require('dgram');
var net = require('net');

var consts = require('./consts');
var dnsClients = require('./dns-clients');

var META_SUFFIX = '._cns_meta';
var TTL = consts.TTL;
var NS_TTL = consts.NS_TTL;
var VERSION = consts.VERSION;
var MAX_NOTIFY_FAILURES = 5;

function DNSServer(opts) {
	assert.object(opts, 'options');

	assert.object(opts.client, 'options.client');
	this.redis = opts.client;

	assert.object(opts.config, 'options.config');
	this.config = opts.config;

	assert.optionalNumber(opts.port, 'options.port');
	this.port = opts.port || 53;
	assert.optionalString(opts.address, 'options.address');
	this.address = opts.address || '0.0.0.0';

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({port: this.port, address: this.address,
	    component: 'DNSServer'});

	this.notifyFailures = {};
	this.notifyInterval = this.config.min_notify_interval;
	if (this.notifyInterval === undefined)
		this.notifyInterval = consts.DEFAULT_MIN_NOTIFY_INT;
	this.checkAndNotify();
	this.unblacklistTimers = {};

	this.peerCounters = {};

	this.peers = [];
	this.addPeer('127.0.0.1');
	this.addPeer('::1');
	this.addPeersFromConfig();

	var s = this.server = named.createServer({log: this.log});

	s.on('query', this.handleQuery.bind(this));
	s.on('error', this.emit.bind(this, 'error'));

	var self = this;
	var listenCount = 0;
	s.listenUdp({port: this.port, address: this.address}, function () {
		log.info('listening on udp/%s:%d', self.address, self.port);
		if (++listenCount >= 2)
			self.emit('listening');
	});
	s.listenTcp({port: this.port, address: this.address}, function () {
		log.info('listening on tcp/%s:%d', self.address, self.port);
		if (++listenCount >= 2)
			self.emit('listening');
	});
}
util.inherits(DNSServer, EventEmitter);

DNSServer.prototype.close = function () {
	this.log.info('closing');
	this.server.close();
	if (this.notifyTimer) {
		clearTimeout(this.notifyTimer);
		delete (this.notifyTimer);
	}
};

DNSServer.prototype.addPeer = function (ipStr, cb) {
	assert.string(ipStr, 'address');
	assert.optionalFunc(cb, 'callback');
	try {
		var ip = ipaddr.parse(ipStr);
		var mask = (ip.kind() === 'ipv4') ? 32 : 128;
		this.peers.push([ip, mask]);
		if (cb)
			cb();
		return;
	} catch (e) {
	}

	try {
		var cidr = ipaddr.parseCIDR(ipStr);
		this.peers.push(cidr);
		if (cb)
			cb();
		return;
	} catch (e) {
	}

	var self = this;
	dns.lookup(ipStr, { family: 6 }, function (err, v4s) {
		dns.lookup(ipStr, { family: 4 }, function (err2, v6s) {
			v4s = err ? [] : v4s;
			v6s = err2 ? [] : v6s;
			var ips = v4s.concat(v6s);
			if (ips.length < 1) {
				self.log.warn({
					peerName: ipStr
				}, 'failed to look up peer addresses');
			}
			for (var i = 0; i < ips.length; ++i) {
				try {
					ip = ipaddr.parse(ips[i]);
				} catch (e) {
					self.log.warn(e, 'failed to parse ' +
					    'peer address "%s" when looking ' +
					    'up %s', ips[i], ipStr);
					continue;
				}
				mask = (ip.kind() === 'ipv4') ? 32 : 128;
				self.peers.push([ip, mask]);
			}
			if (cb)
				cb();
		});
	});
};

DNSServer.prototype.checkPeer = function (ipStr) {
	var ip = ipaddr.parse(ipStr);
	for (var i = 0; i < this.peers.length; ++i) {
		var sip = this.peers[i][0];
		var mask = this.peers[i][1];
		if (sip.kind() === ip.kind()) {
			if (ip.match(sip, mask))
				return (true);
		}
	}
	return (false);
};

DNSServer.prototype.addPeersFromConfig = function () {
	var peers = this.config.allow_transfer || [];
	for (i = 0; i < peers.length; ++i)
		this.addPeer(peers[i]);
	peers = [];
	if (this.config.reverse_zones.peers !== undefined)
		peers = this.config.reverse_zones.peers;
	var zones = Object.keys(this.config.forward_zones);
	for (var i = 0; i < zones.length; ++i) {
		var z = this.config.forward_zones[zones[i]];
		if (z.peers !== undefined)
			peers = peers.concat(z.peers);
	}
	for (i = 0; i < peers.length; ++i)
		this.addPeer(peers[i]);
};

DNSServer.prototype.handleQuery = function (q, cb) {
	assert.object(q, 'query');

	q.log = this.log.child({
		from: sprintf('%s/%s:%d', q.src.family, q.src.address,
		    q.src.port),
		qId: q.id,
		qOp: q.operation(),
		qName: q.name(),
		qType: q.type()
	});
	q.log.trace('begin query');

	var name = q.name();
	var type = q.type();
	var addr = q.src.address;
	var self = this;

	if (q.operation() !== 'query') {
		q.log.debug('ignoring non-query message');
		cb();
		return;
	}

	var idx = name.indexOf(META_SUFFIX);
	if (idx !== -1 && idx + META_SUFFIX.length === name.length) {
		var meta = name.slice(0, idx);
		q.log = q.log.child({zone: '_cns_meta'});
		q.log.trace('found zone');
		self.handleMeta(q, meta, cb);
		return;
	}

	this.findZone(name, function (z) {
		if (z === undefined) {
			q.log.trace('failed to identify zone, ' +
			    'sending servfail');
			q.setError('eserver');
			q.send();
			cb();
			return;
		}
		q.log = q.log.child({zone: z});
		q.log.trace('found zone');

		/* Handle zone transfer requests out in their own func. */
		if (type === 'AXFR' || type === 'IXFR') {
			self.handleTransfer(q, z, cb);
			return;
		}

		/*
		 * SOA and NS queries only return useful metadata when
		 * executed against the root of a zone. If not the root,
		 * fall through to regular record lookup (which will
		 * generate an ENONAME response for these).
		 */
		if (type === 'SOA' && name === z) {
			self.makeSOA(z, function (err, soa) {
				if (err) {
					q.log.warn({err: err},
					    'makesoa failed');
					q.setError('eserver');
					q.send();
					cb();
					return;
				}

				q.addAnswer(z, soa, TTL);
				self.addAuthorityNS(q, z);
				q.send();
				cb();
				q.log.info('responded ok');

				if (self.checkPeer(addr) === true) {
					self.incrPeerCounter(addr, 'soa');
				}
			});
			return;
		}
		if (type === 'NS' && name === z) {
			var ns = self.getNSRecords(z);
			for (var i = 0; i < ns.length; ++i)
				q.addAnswer(z, ns[i], NS_TTL);
			q.send();
			cb();
			q.log.info('responded ok');
			return;
		}

		/*
		 * The "leaf" name is the front part of the DNS name before
		 * the zone. findZone() guarantees that the "z" value is a
		 * suffix of the name, so we can just blindly strip it off
		 * using .slice().
		 */
		var leaf = name.slice(0, name.length - z.length - 1);

		var r = self.redis;
		var k = 'zone:' + z;

		r.hget(k, leaf, function (err, val) {
			if (!err && val !== null) {
				var recs = JSON.parse(val);
				recs = recs.filter(function (rec) {
					return (rec.constructor === type);
				});
				if (recs.length > 0) {
					q.log.trace('respond with %d recs',
					    recs.length);
					self.addAnswers(q, recs);
					self.addAuthorityNS(q, z);
					if (q.type() === 'SRV') {
						self.addAdditionals(recs, z,
						    q, cb);
					} else {
						q.send();
						cb();
						q.log.info('responded ok');
					}
					return;
				}
			}
			self.makeSOA(z, function (err2, soa) {
				if (err2) {
					q.log.warn({err: err2},
					    'makesoa failed');
					q.setError('eserver');
					q.send();
					cb();
					return;
				}

				q.setError('enoname');
				q.addAuthority(z, soa, TTL);
				q.send();
				q.log.info('responded not found');
				cb();
			});
		});
	});
};

DNSServer.prototype.addAdditionals = function (recs, z, q, cb) {
	const ZRE = new RegExp(('.' + z + '$').replace(/[.]/g, '\\.'));
	var r = this.redis;
	var addns = {};

	vasync.forEachParallel({
		inputs: recs,
		func: addAdditional
	}, function (err) {
		q.send();
		cb();
		q.log.info('responded ok');
	});

	function addAdditional(rec, acb) {
		if (rec.constructor !== 'SRV') {
			acb();
			return;
		}

		var target = rec.args[0];
		if (addns[target]) {
			acb();
			return;
		}

		var leaf = target.replace(ZRE, '');
		var k = 'zone:' + z;
		r.hget(k, leaf, function (err, val) {
			if (!err && val !== null) {
				var arecs = JSON.parse(val);
				arecs = arecs.filter(function (rr) {
					return (rr.constructor === 'A' ||
					    rr.constructor === 'AAAA');
				});
				for (var i = 0; i < arecs.length; ++i) {
					q.addAdditional(target,
					    rehydrate(arecs[i]), TTL);
					addns[target] = true;
				}
			}
			acb();
		});
	}
};

/*
 * Finds the zone associated with a given name, and calls cb(err, z).
 *
 * Guarantees that the "z" arg to the callback is a suffix of "name".
 */
DNSServer.prototype.findZone = function (name, cb) {
	assert.string(name, 'name');
	assert.func(cb, 'callback');

	var zs = Object.keys(this.config.forward_zones);
	var i, z, idx;
	for (i = 0; i < zs.length; ++i) {
		idx = name.indexOf(zs[i]);
		if (idx !== -1 && idx + zs[i].length === name.length) {
			z = zs[i];
			break;
		}
	}
	if (z === undefined) {
		var parts = name.toLowerCase().split('.');
		if (parts[parts.length - 1] === 'arpa') {
			var r = this.redis;
			r.keys('zone:*.arpa', function (err, keys) {
				if (err || keys === null) {
					cb(undefined);
					return;
				}

				for (i = 0; i < keys.length; ++i) {
					var k = keys[i].split(':')[1];
					idx = name.indexOf(k);
					if (idx !== -1 && idx + k.length ===
					    name.length) {
						z = k;
						break;
					}
				}

				cb(z);
			});
			return;
		}
	}
	cb(z);
};

/*
 * Shortcut to add all NS records for the zone as Authority records on a
 * query reply
 */
DNSServer.prototype.addAuthorityNS = function (q, z) {
	var recs = this.getNSRecords(z);
	for (var i = 0; i < recs.length; ++i)
		q.addAuthority(z, recs[i], NS_TTL);
};

/*
 * Gets the NS records for a given zone.
 */
DNSServer.prototype.getNSRecords = function (z) {
	var recs = [];

	var conf = this.config.forward_zones[z];
	if (conf === undefined && z.match(/\.arpa$/))
		conf = this.config.reverse_zones;

	if (conf.hidden_primary !== true) {
		var rec = new named.NSRecord(this.config.my_name);
		recs.push(rec);
	}

	var peers = conf.peers || [];
	for (var i = 0; i < peers.length; ++i) {
		rec = new named.NSRecord(peers[i]);
		recs.push(rec);
	}

	return (recs);
};

/*
 * Takes an array of flattened "recs" as stored in redis, and rehydrates them
 * into named records, then calls q.addAnswer() on each.
 *
 * The optional "name" argument is what name to give to addAnswer. If not
 * given, defaults to q.name(), the query question name.
 */
DNSServer.prototype.addAnswers = function (q, recs, name) {
	name = name || q.name();
	for (var i = 0; i < recs.length; ++i)
		q.addAnswer(name, rehydrate(recs[i]), TTL);
};

function rehydrate(r) {
	var klass = named[r.constructor + 'Record'];
	var args = r.args.slice();
	args.unshift(null);
	klass = klass.bind.apply(klass, args);
	var rec = new klass();
	return (rec);
}

/* Gets a list of all zones and their current serials. */
DNSServer.prototype.getAllZones = function (cb) {
	var self = this;

	var zs = Object.keys(this.config.forward_zones);

	this.redis.keys('zone:*.arpa', function (err, keys) {
		if (err || keys === null)
			return;

		for (var i = 0; i < keys.length; ++i) {
			var k = keys[i].split(':')[1];
			zs.push(k);
		}

		vasync.forEachParallel({
			func: getZoneSerial,
			inputs: zs
		}, function (err2, res) {
			cb(err2, res.successes);
		});

		function getZoneSerial(z, scb) {
			var zk = 'zone:' + z + ':latest';
			self.redis.get(zk, function (err3, serStr) {
				var res = {};
				res.zone = z;
				if (err) {
					scb(err);
					return;
				}
				if (serStr === null) {
					scb(null, res);
					return;
				}
				res.serial = parseInt(serStr, 10);
				scb(null, res);
			});
		}
	});
};

/*
 * Periodically check all peer secondaries and their serials, and send NOTIFY
 * as needed.
 *
 * Also calls the incremental record garbage collector, since it needs the same
 * information and runs periodically.
 */
DNSServer.prototype.checkAndNotify = function () {
	var self = this;

	clearTimeout(self.notifyTimer);
	delete (self.notifyTimer);

	this.getAllZones(function (err, zs) {
		var serials = {};
		zs.forEach(function (z) {
			if (z.serial !== undefined)
				serials[z.zone] = z.serial;
		});

		self.getPeerSerials(function (err2, peers) {
			if (!err2) {
				Object.keys(peers).forEach(function (peer) {
					var zones = Object.keys(peers[peer]);
					zones.forEach(function (z) {
						var s = peers[peer][z];
						if (serials[z] !== undefined &&
						    s < serials[z]) {
							self.notify(peer, z);
						}
					});
				});

				self.garbageCollect(serials, peers);
			}

			if (self.notifyTimer !== undefined)
				return;
			/* Schedule the next check. */
			self.notifyTimer = setTimeout(
			    self.checkAndNotify.bind(self),
			    self.notifyInterval);
		});
	});
};

DNSServer.prototype.garbageCollect = function (serials, peers, cb) {
	var self = this;

	/* First build the lookup of minimum required serial for each zone. */
	var minSerial = Object.create(serials);
	Object.keys(peers).forEach(function (peer) {
		if (peer === '127.0.0.1' || peer === '::1')
			return;
		var zones = peers[peer];
		Object.keys(zones).forEach(function (zone) {
			if (minSerial[zone] !== undefined &&
			    zones[zone] < minSerial[zone]) {
				minSerial[zone] = zones[zone];
			}
		});
	});

	vasync.forEachPipeline({
		func: doZone,
		inputs: Object.keys(serials)
	}, function (err, res) {
		if (cb)
			cb(err);
	});

	function doZone(zone, zcb) {
		var k = 'zone:' + zone + ':all';
		self.redis.lrange(k, 0, -1, function (err2, zserials) {
			if (err2 || zserials === null || zserials === []) {
				zcb(null);
				return;
			}
			zserials = zserials.map(function (v) {
				return (parseInt(v, 10));
			}).filter(function (v) {
				return (v < minSerial[zone]);
			});
			/*
			 * Policy: all serials < the minimum required serial
			 * for this zone will be dropped, except the last 2.
			 */
			zserials = zserials.slice(0, -2);
			if (zserials.length > 0) {
				self.log.debug({zone: zone},
				    'garbage collecting %d serials',
				    zserials.length);
			}
			vasync.forEachParallel({
				func: doSerial,
				inputs: zserials
			}, zcb);
			function doSerial(serial, scb) {
				self.dropSerial(zone, serial, scb);
			}
		});
	}
};

DNSServer.prototype.dropSerial = function (zone, serial, cb) {
	var keys = [];
	var self = this;
	vasync.pipeline({
		funcs: [findToKeys, findFromKeys, findNsRecKeys,
		    dropKeys, remSerial]
	}, cb);
	function findToKeys(_, kcb) {
		self.redis.keys('zone:' + zone + ':*:' + serial + ':*',
		    function (err, ks) {
			if (err) {
				kcb(err);
				return;
			}
			if (ks !== null) {
				ks.forEach(function (k) {
					var parts = k.split(':');
					if (parts.length === 5 &&
					    parts[0] === 'zone' &&
					    parts[1] === zone &&
					    parts[3] === String(serial) &&
					    (parts[4] === 'add' ||
					    parts[4] === 'remove')) {
						keys.push(k);
					}
				});
			}
			kcb();
		});
	}
	function findFromKeys(_, kcb) {
		self.redis.keys('zone:' + zone + ':' + serial + ':*',
		    function (err, ks) {
			if (err) {
				kcb(err);
				return;
			}
			if (ks !== null) {
				ks.forEach(function (k) {
					var parts = k.split(':');
					if (parts.length === 5 &&
					    parts[0] === 'zone' &&
					    parts[1] === zone &&
					    parts[2] === String(serial) &&
					    (parts[4] === 'add' ||
					    parts[4] === 'remove')) {
						keys.push(k);
					}
				});
			}
			kcb();
		});
	}
	function findNsRecKeys(_, kcb) {
		self.redis.keys('nsrecs:' + zone + ':' + serial,
		    function (err, ks) {
			if (err) {
				kcb(err);
				return;
			}
			if (ks !== null) {
				ks.forEach(function (k) {
					keys.push(k);
				});
			}
			kcb();
		});
	}
	function dropKeys(_, kcb) {
		if (keys.length > 0) {
			keys.push(kcb);
			self.redis.del.apply(self.redis, keys);
		} else {
			kcb();
		}
	}
	function remSerial(_, kcb) {
		self.redis.lrem('zone:' + zone + ':all', 1,
		    String(serial), kcb);
	}
};

/* Send a NOTIFY message to one of our peers, to trigger them to check SOA. */
DNSServer.prototype.notify = function (peer, zone) {
	if (peer === '127.0.0.1' || peer === '::1')
		return;

	var log = this.log.child({peer: peer, zone: zone});
	var self = this;
	var failures = this.notifyFailures[peer];
	if (failures === undefined) {
		this.notifyFailures[peer] = 0;
		failures = 0;
	}
	if (failures >= MAX_NOTIFY_FAILURES)
		return;
	if (failures >= MAX_NOTIFY_FAILURES - 1)
		log.warn('NOTIFY is failing for this peer, will blacklist');

	var n = this.server.createNotify({
		address: peer,
		zone: zone
	});
	n.once('error', function (err) {
		log.debug(err, 'NOTIFY failed');
		onFailure();
	});
	n.once('response', function (q) {
		if (q.error() !== 'noerror') {
			log.debug({rcode: q.error()}, 'NOTIFY failed');
			onFailure();
		} else {
			log.trace('sent NOTIFY, got ok response');
			self.notifyFailures[peer] = 0;
		}
	});
	n.send();

	function onFailure() {
		++self.notifyFailures[peer];
		var blt = self.unblacklistTimers[peer];
		if (blt !== undefined) {
			clearTimeout(blt);
			delete (self.unblacklistTimers[peer]);
		}
	}
};

DNSServer.prototype.getPeerVersions = function (cb) {
	var self = this;
	var peers = {};
	this.redis.keys('peer:*:version', function (err, keys) {
		if (err) {
			cb(err);
			return;
		}
		if (keys === null || keys.length === 0) {
			cb(null, {});
			return;
		}

		vasync.forEachParallel({
			func: addPeer,
			inputs: keys
		}, function (err2, res) {
			if (err2)
				cb(err2);
			else
				cb(null, peers);
		});

		function addPeer(key, scb) {
			var parts = key.split(':');
			if (parts.length !== 3 || parts[2] !== 'version') {
				scb();
				return;
			}
			self.redis.get(key, function (err3, val) {
				var host = parts[1];
				if (err3) {
					scb(err3);
					return;
				}
				if (val !== null)
					peers[host] = val;
				scb();
			});
		}
	});
};

DNSServer.prototype.getPeerSerials = function (cb) {
	var self = this;
	var peers = {};
	this.redis.keys('peer:*', function (err, keys) {
		if (err) {
			cb(err);
			return;
		}
		if (keys === null || keys.length === 0) {
			cb(null, {});
			return;
		}

		vasync.forEachParallel({
			func: addPeer,
			inputs: keys
		}, function (err2, res) {
			if (err2)
				cb(err2);
			else
				cb(null, peers);
		});

		function addPeer(key, scb) {
			var parts = key.split(':');
			if (parts.length !== 2) {
				scb();
				return;
			}
			self.redis.hgetall(key, function (err3, obj) {
				if (err3) {
					scb(err3);
					return;
				}
				if (obj !== null) {
					var host = parts[1];
					Object.keys(obj).forEach(function (k) {
						obj[k] = parseInt(obj[k], 10);
					});
					peers[host] = obj;
				}
				scb();
			});
		}
	});
};

/*
 * Handles meta-queries for server status information.
 */
DNSServer.prototype.handleMeta = function (q, meta, cb) {
	var name = q.name();
	var rec;

	if (meta === 'version') {
		rec = new named.TXTRecord(
		    VERSION + ', node ' + process.version);
		q.addAnswer(name, rec, 0);
		q.send();
		cb();
		return;
	}

	q.setError('nxdomain');
	q.send();
	cb();
};

function normalizeIP(addr) {
	var ipAddr = ipaddr.parse(addr);
	if (ipAddr.toNormalizedString)
		return (ipAddr.toNormalizedString());
	else
		return (ipAddr.toString());
}

DNSServer.prototype.incrPeerCounter = function (peer, counter) {
	var addr = normalizeIP(peer);
	if (this.peerCounters[addr] === undefined)
		this.peerCounters[addr] = {};
	if (this.peerCounters[addr][counter] === undefined)
		this.peerCounters[addr][counter] = 0;
	++(this.peerCounters[addr][counter]);
};

DNSServer.prototype.startUnblacklist = function (peer) {
	var self = this;
	if (this.unblacklistTimers[peer] === undefined) {
		this.unblacklistTimers[peer] = setTimeout(function () {
			self.notifyFailures[peer] = 0;
			delete (self.unblacklistTimers[peer]);
		}, 300000);
	}
};

/*
 * Handles zone transfers, both whole (AXFR) and incremental (IXFR).
 */
DNSServer.prototype.handleTransfer = function (q, z, cb) {
	var self = this;
	var r = this.redis;
	var i;
	var addr = q.src.address;

	/* Check this is one of our registered peers. */
	if (this.checkPeer(addr) === false) {
		q.log.warn('transfer denied');
		q.setError('erefuse');
		q.send();
		cb();
		return;
	}

	this.makeSOA(z, function (err, soa) {
		if (err) {
			q.log.warn({err: err}, 'makesoa failed');
			q.setError('eserver');
			q.send();
			cb();
			return;
		}
		/*
		 * Save the serial, we will modify the SOA for IXFR and need
		 * to change it back for the final closing SOA record.
		 */
		var newSerial = soa.serial;

		q.addAnswer(z, soa, TTL);
		soa = new named.SOARecord(soa.host, soa);
		var pushed = 1;

		var finish = function () {
			soa.serial = newSerial;
			q.addAnswer(z, soa, TTL);

			var log  = q.log;
			setTimeout(function () {
				dnsClients.getPeerSOA(addr, z,
				    function (qerr, qsoa) {
					if (qerr) {
						log.warn(qerr,
						    'xfer follow-up failed');
						return;
					}
					if (qsoa.serial < newSerial) {
						log.warn(
						    'xfer follow-up showed ' +
						    'peer still stuck on ' +
						    'serial %d', qsoa.serial);
						return;
					}
					/* Write down the transfer in redis. */
					r.hset('peer:' + normalizeIP(addr),
					    z, String(qsoa.serial));
					self.incrPeerCounter(addr, 'goodxfer');
					self.startUnblacklist(addr);
				});
				dnsClients.probePeerVersion(addr,
				    function (perr, pver) {
					if (perr) {
						log.debug(perr,
						    'unable to detect peer ' +
						    'version');
						return;
					}
					r.set('peer:' + normalizeIP(addr) +
					    ':version', pver);
				});
			}, 1000);

			q.send();
			cb();
			q.log.info('responded ok');
		};

		if (q.type() === 'IXFR') {
			var oldSerial = q.ixfrBase();

			self.incrPeerCounter(addr, 'ixfr');

			r.lrange('zone:' + z + ':all', 0, -1,
			    function (err2, serials) {
				if (err2 || serials === null) {
					q.log.warn({err: err2},
					    'failed to list serials for zone');
					q.setError('eserver');
					q.send();
					cb();
					return;
				}

				serials = serials.map(function (s) {
					return (parseInt(s, 10));
				});

				var first;
				var funcs = [];
				for (i = 0; i < serials.length - 1; ++i) {
					if (serials[i] === oldSerial)
						first = true;
					if (serials[i] > oldSerial &&
					    first === undefined &&
					    i > 0 &&
					    serials[i-1] <= oldSerial) {
						i -= 1;
						first = true;
					}
					if (first !== undefined) {
						var f = self.sendIxfrDiff.bind(
						    self, q, z,
						    serials[i], serials[i + 1]);
						funcs.push(f);
					}
				}

				if (funcs.length < 1) {
					doAxfr();
				} else {
					vasync.pipeline({
						funcs: funcs,
						arg: soa
					}, finish);
				}
			});

		} else {
			self.incrPeerCounter(addr, 'axfr');
			doAxfr();
		}

		function doAxfr() {
			var ns = self.getNSRecords(z);
			for (i = 0; i < ns.length; ++i) {
				q.addAnswer(z, ns[i], NS_TTL);
				pushed++;
			}
			r.hgetall('zone:' + z, function (err2, zrecs) {
				if (err2 || zrecs === null) {
					finish();
					return;
				}
				var names = Object.keys(zrecs);
				for (i = 0; i < names.length; ++i) {
					var name = names[i];
					var recs = JSON.parse(zrecs[name]);
					assert.arrayOfObject(recs);
					self.addAnswers(q, recs,
					    name + '.' + z);
					pushed += recs.length;
					if (pushed >= 100) {
						q.send();
						pushed = 0;
					}
				}
				finish();
			});
		}
	});
};

DNSServer.prototype.sendIxfrDiff = function (q, z, from, to, soa, cb) {
	var self = this;
	var r = this.redis;

	var rmKey = sprintf('zone:%s:%d:%d:remove', z, from, to);
	var addKey = sprintf('zone:%s:%d:%d:add', z, from, to);

	var i;
	var nsDiff;
	var pushed = 0;
	var pushRecs = function (recs) {
		if (typeof (recs[0]) === 'string')
			recs = recs.map(JSON.parse);
		for (i = 0; i < recs.length; ++i) {
			assert.object(recs[i]);
			assert.object(recs[i].record);
			assert.optionalString(recs[i].name);
			self.addAnswers(q, [recs[i].record],
			    recs[i].name ? (recs[i].name + '.' + z) : z);
			pushed++;
			if (pushed > 100) {
				q.send();
				pushed = 0;
			}
		}
	};

	var oldNsKey = sprintf('nsrecs:%s:%d', z, from);
	var newNsKey = sprintf('nsrecs:%s:%d', z, to);

	vasync.pipeline({
		funcs: [doNS, doRecs]
	}, cb);

	function doNS(_, rcb) {
		r.get(oldNsKey, function (err, oldv) {
			r.get(newNsKey, function (err2, newv) {
				if (err || err2) {
					rcb(err || err2);
					return;
				}
				if (oldv !== null && newv !== null) {
					var oldNs = JSON.parse(oldv);
					var newNs = JSON.parse(newv);
					nsDiff = utils.recSetDiff(oldNs, newNs);
					q.log.trace({diff: nsDiff},
					    'ixfr includes ns diff');
				}
				rcb();
			});
		});
	}

	function doRecs(_, rcb) {
		r.lrange(rmKey, 0, -1, function (err, recs) {
			q.log.trace('adding removes %d=>%d', from, to);
			soa = new named.SOARecord(soa.host, soa);
			soa.serial = from;
			q.addAnswer(z, soa, TTL);
			pushed++;
			if (pushed > 100) {
				q.send();
				pushed = 0;
			}

			if (nsDiff && nsDiff.remove.length > 0) {
				pushRecs(nsDiff.remove.map(function (re) {
					return ({ record: re });
				}));
			}
			if (!err && recs !== null)
				pushRecs(recs);

			r.lrange(addKey, 0, -1, function (err2, recs2) {
				q.log.trace('adding adds %d=>%d', from, to);
				soa = new named.SOARecord(soa.host, soa);
				soa.serial = to;
				q.addAnswer(z, soa, TTL);
				pushed++;
				if (pushed > 100) {
					q.send();
					pushed = 0;
				}

				if (nsDiff && nsDiff.add.length > 0) {
					pushRecs(nsDiff.add.map(function (re) {
						return ({ record: re });
					}));
				}
				if (!err2 && recs2 !== null)
					pushRecs(recs2);

				rcb(null);
			});
		});
	}
};

/*
 * Generates an SOA (start-of-authority) record for a zone.
 */
DNSServer.prototype.makeSOA = function (z, cb) {
	assert.string(z, 'zone');
	assert.func(cb, 'callback');

	var self = this;
	var r = this.redis;

	r.get('zone:' + z + ':latest', function (err, val) {
		var serial;
		if (!err && val !== null)
			serial = parseInt(val, 10);
		if (serial === undefined) {
			self.log.warn({zone: z, err: err},
			    'failed getting serial for zone, using default');
			serial = utils.currentSerial();
		}

		var zconfig = self.config.forward_zones[z];
		if (zconfig === undefined && z.indexOf('.arpa') !== -1)
			zconfig = self.config.reverse_zones;

		var mname = self.config.my_name;
		if (zconfig.hidden_primary === true) {
			assert.arrayOfString(zconfig.peers,
			    'peers (in zone ' + z + ')');
			mname = zconfig.peers[0];
		}

		var soa = new named.SOARecord(mname, {
			serial: serial,
			admin: self.config.hostmaster.replace('@', '.'),
			refresh: 60,
			retry: 60,
			expire: 181440,
			ttl: TTL
		});

		cb(null, soa);
	});
};

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

var consts = require('./consts');

var META_SUFFIX = '._cns_meta';

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

	this.slaves = [];
	this.addSlave('127.0.0.1');
	this.addSlave('::1');
	this.addSlavesFromConfig();

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
};

DNSServer.prototype.addSlave = function (ipStr, cb) {
	assert.string(ipStr, 'address');
	assert.optionalFunc(cb, 'callback');
	try {
		var ip = ipaddr.parse(ipStr);
		var mask = (ip.kind() === 'ipv4') ? 32 : 128;
		this.slaves.push([ip, mask]);
		if (cb)
			cb();
		return;
	} catch (e) {
	}

	try {
		var cidr = ipaddr.parseCIDR(ipStr);
		this.slaves.push(cidr);
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
					slaveName: ipStr
				}, 'failed to look up slave addresses');
			}
			for (var i = 0; i < ips.length; ++i) {
				ip = ipaddr.parse(ips[i]);
				mask = (ip.kind() === 'ipv4') ? 32 : 128;
				self.slaves.push([ip, mask]);
			}
			if (cb)
				cb();
		});
	});
};

DNSServer.prototype.checkSlave = function (ipStr) {
	var ip = ipaddr.parse(ipStr);
	for (var i = 0; i < this.slaves.length; ++i) {
		var sip = this.slaves[i][0];
		var mask = this.slaves[i][1];
		if (sip.kind() === ip.kind()) {
			if (ip.match(sip, mask))
				return (true);
		}
	}
	return (false);
};

DNSServer.prototype.addSlavesFromConfig = function () {
	var slaves = this.config.allow_transfer || [];
	for (i = 0; i < slaves.length; ++i)
		this.addSlave(slaves[i]);
	slaves = [];
	if (this.config.reverse_zones.slaves !== undefined)
		slaves = this.config.reverse_zones.slaves;
	var zones = Object.keys(this.config.forward_zones);
	for (var i = 0; i < zones.length; ++i) {
		var z = this.config.forward_zones[zones[i]];
		if (z.slaves !== undefined)
			slaves = slaves.concat(z.slaves);
	}
	for (i = 0; i < slaves.length; ++i)
		this.addSlave(slaves[i]);
};

DNSServer.prototype.handleQuery = function (q, cb) {
	assert.object(q, 'query');

	q.log = this.log.child({
		from: sprintf('%s/%s:%d', q.src.family, q.src.address,
		    q.src.port),
		qId: q.id,
		qName: q.name(),
		qType: q.type()
	});
	q.log.trace('begin query');

	var name = q.name();
	var type = q.type();
	var self = this;

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

				q.addAnswer(z, soa, 60);
				self.addAuthorityNS(q, z);
				q.send();
				cb();
				q.log.info('responded ok');
			});
			return;
		}
		if (type === 'NS' && name === z) {
			var ns = self.getNSRecords(z);
			for (var i = 0; i < ns.length; ++i)
				q.addAnswer(z, ns[i], 3600);
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
					q.send();
					cb();
					q.log.info('responded ok');
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
				q.addAuthority(z, soa, 60);
				q.send();
				q.log.info('responded not found');
				cb();
			});
		});
	});
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
		q.addAuthority(z, recs[i], 3600);
};

/*
 * Gets the NS records for a given zone.
 */
DNSServer.prototype.getNSRecords = function (z) {
	var recs = [];

	var conf = this.config.forward_zones[z];
	if (conf === undefined && z.match(/\.arpa$/))
		conf = this.config.reverse_zones;

	if (conf.hidden_master !== true) {
		var rec = new named.NSRecord(this.config.my_name);
		recs.push(rec);
	}

	var slaves = conf.slaves || [];
	for (var i = 0; i < slaves.length; ++i) {
		rec = new named.NSRecord(slaves[i]);
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
	for (var i = 0; i < recs.length; ++i) {
		var r = recs[i];
		var klass = named[r.constructor + 'Record'];
		r.args.unshift(null);
		klass = klass.bind.apply(klass, r.args);
		var rec = new klass();
		q.addAnswer(name, rec, 60);
	}
};

/*
 * Handles meta-queries for server status information.
 */
DNSServer.prototype.handleMeta = function (q, meta, cb) {
	var name = q.name();
	if (meta === 'slaves') {
		this.slaves.forEach(function (s) {
			var rec;
			if (s.kind() === 'ipv4')
				rec = new named.ARecord(s.toString());
			else if (s.kind() === 'ipv6')
				rec = new named.AAAARecord(s.toString());
			q.addAnswer(name, rec, 3600);
		});
		q.send();
		cb();

	} else if (meta === 'zones') {
		var zs = Object.keys(this.config.forward_zones);
		for (var i = 0; i < zs.length; ++i)
			q.addAnswer(name, new named.TXTRecord(zs[i]), 3600);

		this.redis.keys('zone:*.arpa', function (err, keys) {
			if (err || keys === null) {
				q.send();
				cb();
				return;
			}

			for (i = 0; i < keys.length; ++i) {
				var k = keys[i].split(':')[1];
				q.addAnswer(name, new named.TXTRecord(k), 3600);
			}

			q.send();
			cb();
		});
	}
};

/*
 * Handles zone transfers, both whole (AXFR) and incremental (IXFR).
 */
DNSServer.prototype.handleTransfer = function (q, z, cb) {
	var self = this;
	var r = this.redis;
	var i;

	/* Check this is one of our registered slaves. */
	if (this.checkSlave(q.src.address) === false) {
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

		q.addAnswer(z, soa, 60);
		soa = new named.SOARecord(soa.host, soa);
		var pushed = 1;

		var finish = function () {
			soa.serial = newSerial;
			q.addAnswer(z, soa, 60);
			q.send();
			cb();
			q.log.info('responded ok');
		};

		if (q.type() === 'IXFR') {
			var oldSerial = q.ixfrBase();

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
					if (first !== undefined) {
						var f = self.sendIxfrDiff.bind(
						    self, q, z,
						    serials[i], serials[i + 1]);
						funcs.push(f);
					}
				}

				vasync.pipeline({
					funcs: funcs,
					arg: soa
				}, finish);
			});

		} else {
			var ns = self.getNSRecords(z);
			for (i = 0; i < ns.length; ++i) {
				q.addAnswer(z, ns[i], 3600);
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

	var pushed = 0;
	var pushRecs = function (recs) {
		recs = recs.map(JSON.parse);
		for (i = 0; i < recs.length; ++i) {
			assert.object(recs[i]);
			assert.object(recs[i].record);
			assert.string(recs[i].name);
			self.addAnswers(q, [recs[i].record],
			    recs[i].name + '.' + z);
			pushed++;
			if (pushed > 100) {
				q.send();
				pushed = 0;
			}
		}
	};

	r.lrange(rmKey, 0, -1, function (err, recs) {
		q.log.trace('adding removes %d=>%d', from, to);
		soa = new named.SOARecord(soa.host, soa);
		soa.serial = from;
		q.addAnswer(z, soa, 60);
		pushed++;
		if (pushed > 100) {
			q.send();
			pushed = 0;
		}

		if (!err && recs !== null)
			pushRecs(recs);

		r.lrange(addKey, 0, -1, function (err2, recs2) {
			q.log.trace('adding adds %d=>%d', from, to);
			soa = new named.SOARecord(soa.host, soa);
			soa.serial = to;
			q.addAnswer(z, soa, 60);
			pushed++;
			if (pushed > 100) {
				q.send();
				pushed = 0;
			}

			if (!err2 && recs2 !== null)
				pushRecs(recs2);

			q.log.trace('calling ixfrdiff cb');
			cb(null);
		});
	});
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

		var soa = new named.SOARecord(self.config.my_name, {
			serial: serial,
			admin: self.config.hostmaster.replace('@', '.'),
			refresh: 60,
			retry: 60,
			expire: 181440,
			ttl: 60
		});

		cb(null, soa);
	});
};

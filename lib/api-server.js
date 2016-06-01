/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = APIServer;

var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var vasync = require('vasync');
var ipaddr = require('ipaddr.js');
var crypto = require('crypto');
var net = require('net');
var dns = require('dns');
var consts = require('./consts');
var restify = require('restify');
var child_process = require('child_process');
var fs = require('fs');

var VERSION = consts.VERSION;
var TTL = consts.TTL;
var NS_TTL = consts.NS_TTL;

function APIServer(opts) {
	assert.object(opts, 'options');

	assert.object(opts.client, 'options.client');
	this.redis = opts.client;

	assert.object(opts.dnsServer, 'options.dnsServer');
	this.dnsServer = opts.dnsServer;

	assert.object(opts.config, 'options.config');
	this.config = opts.config;

	assert.optionalNumber(opts.port, 'options.port');
	this.port = opts.port || 80;

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({
		port: this.port,
		component: 'APIServer'
	});

	var self = this;
	this.servers = [];

	var opts = {};
	opts.cwd = '/tmp';
	if (fs.existsSync('/usr/bin/pfsh'))
		opts.shell = '/usr/bin/pfsh';
	if (fs.existsSync('/usr/sbin/mdata-get')) {
		child_process.exec('/usr/sbin/mdata-get sdc:nics', opts,
		    function (err, stdout, stderr) {
			if (err) {
				self.log.warn({
				    exit_status: err.code,
				    stderr: stderr
				    }, 'failed to execute mdata-get, API will' +
				    ' listen only on localhost');
				return;
			}
			var nics = JSON.parse(stdout);
			assert.arrayOfObject(nics);
			var adminIps = nics.filter(function (n) {
				if (n.nic_tag !== 'admin')
					return (false);
				if (!n.ip)
					return (false);
				var ip = ipaddr.parse(n.ip);
				return (ip.range() === 'private');
			}).map(function (n) {
				return (n.ip);
			});

			adminIps.forEach(function (addr) {
				setupServer.call(self, addr);
			});
		});
	} else {
		self.log.info('failed to find mdata-get, API will listen ' +
		    'only on localhost');
	}

	['127.0.0.1', '::1'].forEach(function (addr) {
		setupServer.call(self, addr);
	});
}

function tryLookup(addr, retries, timeout) {
	var self = this;
	var done = false;
	var timer;
	dns.lookup(addr, function onResult(err, ip) {
		if (done)
			return;
		if (timer)
			clearTimeout(timer);
		timer = undefined;
		done = true;
		if (err) {
			if (retries > 0) {
				setTimeout(tryLookup.bind(self, addr,
				    retries - 1, timeout * 1.5), timeout);
			} else {
				self.log.warn(err,
				    'failed to look up %s', addr);
			}
		} else {
			setupServer.call(self, ip);
		}
	});
	timer = setTimeout(onTimeout, timeout);
	function onTimeout() {
		if (done)
			return;
		timer = undefined;
		done = true;
		if (retries > 0) {
			setTimeout(tryLookup.bind(self, addr, retries - 1,
			    timeout * 1.5), timeout);
		} else {
			self.log.warn(new Error('Timeout looking up DNS name'),
			    'failed to look up %s', addr);
		}
	}
}

function setupServer(addr) {
	var self = this;
	var slog = self.log.child({
		listen: addr + ':' + self.port
	});
	var server = restify.createServer({
		log: slog
	});
	setupRoutes.call(self, server);

	server.pre(function (req, res, next) {
		req.log = slog.child({req: req, res: res});
		next();
	});

	server.on('after', restify.auditLogger({
		log: slog
	}));
	server.on('uncaughtException', function (req, res, route, err) {
		req.log.error(err);
		res.send(err);
	});
	server.listen(self.port, addr, function () {
		slog.info('listening on tcp/%s:%d', addr, self.port);
	});

	self.servers.push(server);
}

function setupRoutes(s) {
	s.get({
		path: '/ping',
		version: '1.0.0'
	}, ping_v1.bind(this));

	s.get({
		path: '/vm/:uuid',
		version: '1.0.0'
	}, getVM_v1.bind(this));

	s.get({
		path: '/peers',
		version: '1.0.0'
	}, getPeers_v1.bind(this));

	s.get({
		path: '/peer/:addr',
		version: '1.0.0'
	}, getPeer_v1.bind(this));

	s.del({
		path: '/peer/:addr',
		version: '1.0.0'
	}, delPeer_v1.bind(this));

	s.get({
		path: '/zones',
		version: '1.0.0'
	}, getZones_v1.bind(this));

	s.get({
		path: '/allowed-peers',
		version: '1.0.0'
	}, getAllowedPeers_v1.bind(this));
}

function ping_v1(req, res, next) {
	res.send(200);
	next();
}

function getVM_v1(req, res, next) {
	var self = this;
	var uuid = req.params.uuid;
	var result = {};
	result.uuid = uuid;

	self.redis.hgetall('vm:' + uuid, function (err, val) {
		var e;
		if (err) {
			e = new Error('Error communicating with ' +
			    'redis: ' + err.code + ': ' + err.message);
			e.statusCode = 500;
			next(e);
			return;
		}
		if (val === null || typeof (val.last_recs) !== 'string') {
			e = new Error('VM not found');
			e.statusCode = 404;
			next(e);
			return;
		}

		var lastrecs = JSON.parse(val.last_recs);
		result.names = [];

		Object.keys(lastrecs).forEach(function (z) {
			var zonerecs = lastrecs[z];
			Object.keys(zonerecs).forEach(function (zn) {
				var recs = zonerecs[zn];
				var txts = recs.filter(function (r) {
					return (r.constructor === 'TXT');
				});
				if (txts.length > 0 &&
				    txts[0].args[0] === uuid) {
					result.names.push(zn + '.' + z);
				}
			});
		});

		var lastvisit = parseInt(val.last_visit, 10);
		result.last_visit = lastvisit * 1000;

		res.send(result);
		next();
	});
}

function getPeer_v1(req, res, next) {
	var self = this;
	var addr = normalizeIP(req.params.addr);
	var peer = {};
	peer.address = addr;

	vasync.pipeline({
		funcs: [fetchSerials, fetchVersion, fetchStatus]
	}, function (err) {
		if (err) {
			next(err);
			return;
		}
		res.send(peer);
		next();
	});

	function fetchSerials(_, cb) {
		self.redis.hgetall('peer:' + addr, function (err, serials) {
			var rerr;
			if (err) {
				rerr = new Error('Error communicating with ' +
				    'redis: ' + err.name + ': ' + err.message);
				rerr.statusCode = 500;
				cb(rerr);
				return;
			}
			if (serials === null || serials === {}) {
				rerr = new Error('Peer not found');
				rerr.statusCode = 404;
				cb(rerr);
				return;
			}

			Object.keys(serials).forEach(function (k) {
				serials[k] = parseInt(serials[k], 10);
			});

			peer.serials = serials;
			cb();
		});
	}

	function fetchVersion(_, cb) {
		self.redis.get('peer:' + addr + ':version',
		    function (err, ver) {
			var rerr;
			if (err) {
				rerr = new Error('Error communicating with ' +
				    'redis: ' + err.name + ': ' + err.message);
				rerr.statusCode = 500;
				cb(rerr);
				return;
			}
			if (ver === null) {
				peer.version = 'unknown';
				cb();
				return;
			}
			peer.version = ver;
			cb();
		});
	}

	function fetchStatus(_, cb) {
		peer.notify_failures = self.dnsServer.notifyFailures[addr];
		peer.using_notify = (peer.notify_failures < 5);
		var counters = self.dnsServer.peerCounters[addr];
		if (counters) {
			var ixfrs = counters.ixfr || 0;
			var axfrs = counters.axfr || 0;
			peer.using_ixfr = (ixfrs > axfrs * 2);
			peer.counters = counters;
		} else {
			peer.using_ixfr = false;
			peer.counters = {};
		}
		cb();
	}
}

function delPeer_v1(req, res, next) {
	var addr = normalizeIP(req.params.addr);

	this.redis.del('peer:' + addr, 'peer:' + addr + ':version',
	    function (err) {
		if (err) {
			next(err);
			return;
		}
		res.send(200);
		next();
	});
}

function normalizeIP(addr) {
	var ip = ipaddr.parse(addr);
	if (ip.toNormalizedString)
		return (ip.toNormalizedString());
	else
		return (ip.toString());
}

function getPeers_v1(req, res, next) {
	var self = this;
	var peers = [];
	var peerLookup = {};

	vasync.pipeline({
		funcs: [fetchSerials, fetchVersions]
	}, function (err) {
		if (err) {
			next(err);
			return;
		}
		res.send(peers);
		next();
	});

	function fetchSerials(_, cb) {
		self.dnsServer.getPeerSerials(function (err, sres) {
			if (err) {
				cb(err);
				return;
			}
			Object.keys(sres).forEach(function (p) {
				var peer = peerLookup[p];
				if (peer === undefined) {
					peer = (peerLookup[p] = {});
					peers.push(peer);
					peer.address = p;
				}
				peer.serials = {};
				var zones = Object.keys(sres[p]);
				zones.forEach(function (z) {
					peer.serials[z] = sres[p][z];
				});
			});
			cb();
		});
	}

	function fetchVersions(_, cb) {
		self.dnsServer.getPeerVersions(function (err, vres) {
			if (err) {
				cb(err);
				return;
			}
			Object.keys(vres).forEach(function (p) {
				var peer = peerLookup[p];
				if (peer === undefined) {
					peer = (peerLookup[p] = {});
					peers.push(peer);
					peer.address = p;
				}
				peer.version = vres[p];
			});
			cb();
		});
	}
}

function getZones_v1(req, res, next) {
	var self = this;
	var zoneNames = Object.keys(this.config.forward_zones);
	var zones = [];

	this.redis.keys('zone:*.arpa', function (err, keys) {
		if (!err && keys !== null) {
			for (var i = 0; i < keys.length; ++i) {
				var k = keys[i].split(':')[1];
				zoneNames.push(k);
			}
		}

		vasync.forEachParallel({
			func: addZone,
			inputs: zoneNames
		}, function (err2) {
			if (err2) {
				next(err2);
				return;
			}
			res.send(zones);
			next();
		});

		function addZone(z, cb) {
			self.redis.get('zone:' + z + ':latest',
			    function (err2, val) {
				if (err2) {
					var e = new Error('Redis error: ' +
					    err2.code + ': ' + err2.message);
					e.statusCode = 500;
					cb(e);
					return;
				}

				if (val === null) {
					zones.push({
						name: z,
						serial: utils.currentSerial()
					});
				} else {
					zones.push({
						name: z,
						serial: parseInt(val, 10)
					});
				}
				cb();
			});
		}
	});
}

function getAllowedPeers_v1(req, res, next) {
	var allowed = [];
	var s = this.dnsServer;

	for (var i = 0; i < s.peers.length; ++i) {
		var ip = s.peers[i][0];
		var mask = s.peers[i][1];
		allowed.push({
			address: ip.toString(),
			mask: mask
		});
	}

	res.send(allowed);
	next();
}

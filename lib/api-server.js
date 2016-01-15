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
var consts = require('./consts');
var restify = require('restify');

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
	this.log = log.child({port: this.port, component: 'APIServer'});

	var self = this;
	this.server = restify.createServer({
		log: this.log
	});

	setupRoutes.call(this);

	this.server.listen(this.port, function () {
		self.log.info('listening on tcp/%d', self.port);
	});
}

function setupRoutes() {
	var s = this.server;

	s.get({
		path: '/version',
		version: '1.0.0'
	}, getVersion_v1.bind(this));

	s.get({
		path: '/vm/:uuid',
		version: '1.0.0'
	}, getVM_v1.bind(this));

	s.get({
		path: '/peers',
		version: '1.0.0'
	}, getPeers_v1.bind(this));

	s.get({
		path: '/zones',
		version: '1.0.0'
	}, getZones_v1.bind(this));

	s.get({
		path: '/allowed-peers',
		version: '1.0.0'
	}, getAllowedPeers_v1.bind(this));
}

function getVersion_v1(req, res, next) {
	res.send({version: VERSION});
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
		if (val === null) {
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
						name: z
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

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var redis = require('redis');
var bunyan = require('bunyan');
var config = require('./lib/config');
var DNSServer = require('./lib/dns-server');
var APIServer = require('./lib/api-server');
var restify = require('restify');
var path = require('path');
var cueball = require('cueball');

var confPath;
if (process.argv[2])
	confPath = process.argv[2];
if (confPath === undefined)
	confPath = path.join(__dirname, 'etc', 'config.json');
var conf = config.parse(confPath);

var log = bunyan.createLogger({
	name: 'cns',
	level: process.env.LOGLEVEL || 'debug',
	serializers: {
		req: restify.bunyan.serializers.req,
		res: restify.bunyan.serializers.res
	}
});

var res = cueball.resolverForIpOrDomain({ input: '127.0.0.1:6379' });
var redisPool = new cueball.ConnectionPool({
	resolver: res,
	domain: 'localhost',
	service: '_redis._tcp',
	defaultPort: 6379,
	log: log,
	spares: 4,
	maximum: 100,
	recovery: {
		default: {
			timeout: 1000,
			delay: 500,
			retries: 5
		}
	},
	constructor: function (backend) {
		var c = redis.createClient({
			host: backend.address,
			port: backend.port,
			enable_offline_queue: false,
			max_attempts: 1
		});
		c.destroy = function () {
			c.end(false);
		};
		c.unref = function () {};
		c.ref = function () {};
		return (c);
	}
});
res.start();

var s = new DNSServer({
	redisPool: redisPool,
	log: log,
	config: conf,
	port: 53
});

var api = new APIServer({
	redisPool: redisPool,
	log: log,
	config: conf,
	port: 80,
	dnsServer: s
});

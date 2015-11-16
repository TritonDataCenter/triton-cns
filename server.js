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
var path = require('path');

var confPath;
if (process.argv[2])
	confPath = process.argv[2];
if (confPath === undefined)
	confPath = path.join(__dirname, 'etc', 'config.json');
var conf = config.parse(confPath);

var client = redis.createClient(conf.redis_opts);

var log = bunyan.createLogger({name: 'cns', level: 'trace'})

var s = new DNSServer({
	client: client,
	log: log,
	config: conf,
	port: 53
});

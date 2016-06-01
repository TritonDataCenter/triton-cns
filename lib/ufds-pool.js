/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = createUfdsPool;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');
var vasync = require('vasync');
var EventEmitter = require('events').EventEmitter;

var consts = require('./consts');

var cueball = require('cueball');
var ldapjs = require('ldapjs');

function createUfdsPool(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	log = log.child({stage: 'UfdsPool'});

	assert.object(opts.config, 'options.config');
	var conf = opts.config;

	var poolOpts = {};
	poolOpts.resolvers = [conf.binder_domain];
	poolOpts.domain = conf.ufds_opts.address;
	poolOpts.service = '_ldap._tcp';
	poolOpts.defaultPort = 636;
	poolOpts.spares = opts.ufdsConnections || 2;
	poolOpts.maximum = 4;
	poolOpts.log = log;
	poolOpts.recovery = {
		default: {
			timeout: 2000,
			retries: 5,
			delay: 250,
			maxDelay: 1000
		}
	};

	poolOpts.constructor = function (backend) {
		var client = ldapjs.createClient({
			url: 'ldaps://' + backend.address + ':' + backend.port,
			log: log,
			queueDisable: true,
			reconnect: false,
			tlsOptions: {
				rejectUnauthorized: false
			}
		});
		client.on('setup', function (cl, cb) {
			cl.bind(conf.ufds_opts.bindDN,
			    conf.ufds_opts.bindPassword, cb);
		});
		client.ref = function () {
			return (this._socket.ref());
		};
		client.unref = function () {
			return (this._socket.unref());
		};
		return (client);
	};

	var pool = new cueball.ConnectionPool(poolOpts);

	return (pool);
}

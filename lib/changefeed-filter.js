/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = ChangefeedFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var restify = require('restify-clients');
var qs = require('querystring');

var consts = require('./consts');

function ChangefeedFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'ChangefeedFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.vmapi_opts, 'config.vmapi_opts');
	this.config = opts.config.vmapi_opts;
	assert.string(this.config.address, 'vmapi_opts.address');

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address
	});

	var streamOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, streamOpts);
}
util.inherits(ChangefeedFilter, stream.Transform);

ChangefeedFilter.prototype._transform = function (chunk, encoding, cb) {
	var log = this.log;
	log.trace('_transfrom: start');
	var vmUuid = chunk.changedResourceId;
	var self = this;
	self.client.get('/vms/' + vmUuid, function (err, req, res, vm) {
		if (err) {
			log.error({ error: err }, 'Error vm uuid: ' + vmUuid);
			cb();
			return;
		}

		/* Delete some attribs that can get pretty big. */
		utils.cleanVM(vm);

		self.push(vm);
		cb();
	});
};

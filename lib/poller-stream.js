/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = PollerStream;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var restify = require('restify-clients');
var qs = require('querystring');

var consts = require('./consts');

function PollerStream(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'PollerStream'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.vmapi_opts, 'config.vmapi_opts');
	this.config = opts.config.vmapi_opts;
	assert.string(this.config.address, 'vmapi_opts.address');
	assert.optionalNumber(this.config.limit, 'vmapi_opts.limit');

	this.maxLimit = this.config.limit || consts.DEFAULT_VMAPI_LIMIT;
	this.limit = this.maxLimit;

	this.running = false;
	this.fetching = false;
	this.offset = 0;
	this.marker = undefined;

	this.useMarker = undefined;
	this.checkingMarker = false;

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address
	});

	var streamOpts = {
		objectMode: true
	};
	stream.Readable.call(this, streamOpts);
}
util.inherits(PollerStream, stream.Readable);

PollerStream.prototype._read = function () {
	this.fetch();
};

/* We probe vmapi first to see if it has "marker" support or not. */
PollerStream.prototype.checkMarker = function () {
	if (this.checkingMarker)
		return;
	this.checkingMarker = true;

	var self = this;
	var q = qs.stringify({
		limit: 1,
		state: 'active',
		marker: JSON.stringify({ uuid: '000000' })
	});
	this.client.get('/vms?' + q, function (err, req, res, objs) {
		if (!err && Array.isArray(objs) && objs.length === 0) {
			self.log.debug('detected marker support in vmapi');
			self.useMarker = true;
		} else {
			self.log.debug('vmapi does not support marker');
			self.useMarker = false;
		}
		self.checkingMarker = false;
		self.start();
		return;
	});
};

PollerStream.prototype.start = function () {
	if (this.useMarker === undefined) {
		this.checkMarker();
		return;
	}
	if (this.running) {
		this.fetch();
		return;
	}
	this.log.debug('starting poll, all active');
	this.running = true;
	this.offset = 0;
	this.marker = undefined;
	this.fetch();
};

PollerStream.prototype.fetch = function () {
	if (this.fetching)
		return;
	if (!this.running)
		return;

	this.fetching = true;

	var self = this;
	var q = {
		limit: this.limit,
		state: 'active'
	};
	if (this.useMarker) {
		if (this.marker !== undefined)
			q.marker = JSON.stringify(this.marker);
	} else {
		q.offset = this.offset;
	}
	q = qs.stringify(q);
	this.client.get('/vms?' + q, function (err, req, res, objs) {
		if (err) {
			self.log.error({
				err: err,
				offset: self.offset,
				marker: self.marker,
				limit: self.limit
			}, 'failed fetching active vms, will retry in 1s');
			self.fetching = false;
			setTimeout(self.fetch.bind(self), 1000);
			return;
		}
		var full = false;

		if (objs.length === 0) {
			self.log.debug({processed: self.offset},
			    'finished poll, all active');
			self.fetching = false;
			self.running = false;
			self.emit('pollFinish');
			return;
		}

		for (var i = 0; i < objs.length; ++i) {
			var obj = objs[i];

			/* Delete some attribs that can get pretty big. */
			utils.cleanVM(obj);

			self.offset++;
			self.marker = { uuid: obj.uuid };
			if (typeof (obj.uuid) !== 'string')
				continue;
			if (!self.push(obj)) {
				self.limit = Math.round(
				    (2*self.limit + (i + 1)) / 3.0);
				self.log.trace('revising limit down to %d',
				    self.limit);
				full = true;
				break;
			}
		}

		if (!full && self.limit < self.maxLimit) {
			self.limit = Math.round(
			    (2*self.limit + self.maxLimit) / 3.0);
			self.log.trace('revising limit up to %d',
			    self.limit);
		}

		self.fetching = false;
		setTimeout(self.fetch.bind(self), 100);
	});
};

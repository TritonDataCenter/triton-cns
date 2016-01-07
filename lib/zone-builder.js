/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = Zone;

var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var consts = require('./consts');
var vasync = require('vasync');
var genuuid = require('uuid').v4;

/*
 * ZoneBuilder (Zone here) is a utility class used to help build the
 * incremental change records in redis that will allow us to serve IXFR
 * requests.
 */
function Zone(opts) {
	assert.object(opts);
	assert.object(opts.client);
	assert.string(opts.name);
	assert.optionalNumber(opts.fromSerial);
	assert.number(opts.toSerial);
	assert.object(opts.log);

	this.client = opts.client;
	this.name = opts.name;
	this.fromSerial = opts.fromSerial;
	this.toSerial = opts.toSerial;
	this.log = opts.log.child({zone: this.name, from: this.fromSerial,
	    to: this.toSerial});

	var base = ['zone', this.name, this.fromSerial, this.toSerial];
	this.rmKey = base.slice().concat(['remove']).join(':');
	this.addKey = base.slice().concat(['add']).join(':');
	this.key = 'zone:' + this.name;

	this.log.trace('dns zone open');

	this.rms = [];
	this.adds = [];
}

Zone.prototype.isDirty = function () {
	return (this.rms.length > 0 || this.adds.length > 0);
};

Zone.prototype.list = function (name, cb) {
	assert.string(name);
	assert.func(cb);

	var c = this.client;
	var self = this;
	c.hget(this.key, name, function (err, val) {
		var recs = [];
		if (!err && val !== null)
			recs = JSON.parse(val);

		var recHash = {};
		recs.forEach(function (r) {
			recHash[r.id] = r;
		});

		self.rms.forEach(function (rm) {
			if (rm.name !== name)
				return;
			delete (recHash[rm.record.id]);
		});

		recs = [];
		Object.keys(recHash).forEach(function (k) {
			recs.push(recHash[k]);
		});

		self.adds.forEach(function (add) {
			if (add.name !== name)
				return;
			recs.push(add.record);
		});

		cb(null, recs);
	});
};

Zone.prototype.clear = function (name, src, cb) {
	assert.string(name);
	assert.func(cb);

	var c = this.client;
	var self = this;
	c.hget(this.key, name, function (err, val) {
		if (!err && val !== null) {
			val = JSON.parse(val);
			val.forEach(function (r) {
				if (src && r.src !== src)
					return;
				r = {name: name, record: r};
				self.rms.push(r);
			});
		}
		self.log.trace('clear %s.%s', name, src);
		cb(null);
	});
};

Zone.prototype.remove = function (name, id, cb) {
	assert.string(name);
	assert.string(id);
	assert.func(cb);

	var c = this.client;
	var self = this;
	c.hget(this.key, name, function (err, val) {
		var recs = [];
		if (!err && val !== null)
			recs = JSON.parse(val);

		var rec;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].id === id) {
				rec = recs[i];
				break;
			}
		}

		if (!rec) {
			var err2 = new Error('Record with id ' + id +
			    ' not found under ' + name + ' in ' + self.name);
			err2.name = name;
			err2.zone = self;
			err2.id = id;
			cb(err2);
			return;
		}

		self.log.trace('remove %s', id);
		self.rms.push({name: name, record: rec});
		cb(null);
	});
};

Zone.prototype.removeObj = function (name, obj, cb) {
	assert.string(name);
	assert.object(obj);
	assert.string(obj.id);
	assert.func(cb);

	this.log.trace('remove %s.%s (%s)', name, obj.src, obj.constructor);
	this.rms.push({name: name, record: obj});
	cb(null);
};

Zone.prototype.addObj = function (name, obj, cb) {
	assert.string(name);
	assert.object(obj);
	assert.string(obj.constructor);
	assert.ok(Array.isArray(obj.args));
	assert.optionalString(obj.src);
	assert.func(cb);

	if (obj.id === undefined)
		obj.id = genuuid();
	assert.string(obj.id);

	this.log.trace('add %s.%s (%s)', name, obj.src, obj.constructor);
	this.adds.push({name: name, record: obj});
	cb(null);
};

Zone.prototype.add = function (name, constructor, args, src, cb) {
	var rec = {
		constructor: constructor,
		args: args,
		src: src,
		id: genuuid()
	};
	this.addObj(name, rec, cb);
};

Zone.prototype.set = function (name, constructor, args, cb) {
	assert.func(cb);
	var self = this;
	this.clear(name, function (err) {
		if (err) {
			cb(err);
			return;
		}
		self.add(name, constructor, args, cb);
	});
};

function saveIxfr(cb) {
	var self = this;
	var c = this.client;

	var funcs = [];
	if (this.fromSerial) {
		this.rms.forEach(function (rm) {
			funcs.push(function (arg, ccb) {
				return (c.rpush(self.rmKey,
				    JSON.stringify(rm), ccb));
			});
		});
		this.adds.forEach(function (add) {
			funcs.push(function (arg, ccb) {
				return (c.rpush(self.addKey,
				    JSON.stringify(add), ccb));
			});
		});
	}
	vasync.pipeline({
		funcs: funcs
	}, cb);
}

function doCommitJob(job, cb) {
	var c = this.client;
	var self = this;
	c.hget(this.key, job.name, function (err, val) {
		var recs = [];
		if (!err && val !== null)
			recs = JSON.parse(val);

		var recHash = {};
		recs.forEach(function (r) {
			recHash[r.id] = r;
		});

		job.remove.forEach(function (rm) {
			delete (recHash[rm.id]);
		});

		recs = [];
		Object.keys(recHash).forEach(function (k) {
			recs.push(recHash[k]);
		});
		recs = recs.concat(job.add);

		recs = JSON.stringify(recs);
		c.hset(self.key, job.name, recs, cb);
	});
}

function makeCommitJobs(q) {
	var jobNames = {};
	this.rms.forEach(function (rm) {
		if (!jobNames[rm.name])
			jobNames[rm.name] = {
				name: rm.name,
				remove: [],
				add: []
			};
		jobNames[rm.name].remove.push(rm.record);
	});
	this.adds.forEach(function (add) {
		if (!jobNames[add.name])
			jobNames[add.name] = {
				name: add.name,
				remove: [],
				add: []
			};
		jobNames[add.name].add.push(add.record);
	});

	Object.keys(jobNames).forEach(function (k) {
		q.push(jobNames[k]);
	});
}

Zone.prototype.commit = function (cb) {
	assert.func(cb);
	var self = this;

	this.log.trace('commit start');
	saveIxfr.call(this, function (err) {
		if (err) {
			cb(err);
			return;
		}
		var q = vasync.queue(doCommitJob.bind(self), 8);

		q.once('end', function () {
			var k = self.key + ':all';
			self.client.rpush(k, String(self.toSerial),
			    function (err2) {
				if (err2) {
					cb(err2);
					return;
				}
				k = self.key + ':latest';
				self.client.set(k, String(self.toSerial),
				    function (err3) {
					self.log.trace('commit finish');
					cb(err3);
				});
			});
		});

		try {
			makeCommitJobs.call(self, q);
		} finally {
			q.close();
		}
	});
};

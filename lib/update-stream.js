/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = UpdateStream;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var vasync = require('vasync');
var genuuid = require('uuid').v4;
var net = require('net');
var bunyan = require('bunyan');

var consts = require('./consts');
var DEFAULT_TRIGGER_INT = consts.DEFAULT_TRIGGER_INT;

/*
 * UpdateStream is the final component in the TCNS update stream setup, and
 * its job is to take the processed VM objects after all the other filters have
 * run and update the redis cache.
 *
 * As part of its operation, it must decide when one zone serial number should
 * end and another should begin. This can either be manual (by some outside code
 * calling openSerial() before writing any records and closeSerial() later), or
 * automatic. In the automatic case, the new serial number will be opened as
 * soon as a record is received, and will be closed at triggerInterval seconds
 * later.
 *
 * In this way, we can guarantee we generate a full valid state after startup in
 * our first serial (by manually triggering before and after a complete poll),
 * and then otherwise rely on timing-based serial numbers for incremental
 * changes thereafter.
 */
function UpdateStream(opts) {
	assert.object(opts, 'options');

	assert.object(opts.client, 'options.client');
	this.client = opts.client;

	assert.object(opts.config, 'options.config');
	this.config = opts.config;

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'UpdateStream'});

	assert.optionalNumber(opts.triggerInterval, 'options.triggerInterval');
	this.triggerInterval = opts.triggerInterval || DEFAULT_TRIGGER_INT;

	this.serial = undefined;
	this.timer = undefined;
	this.zones = {};

	var streamOpts = {objectMode: true};
	stream.Writable.call(this, streamOpts);
}
util.inherits(UpdateStream, stream.Writable);

UpdateStream.prototype.openSerial = function (timeBased) {
	if (this.serial !== undefined)
		return;

	if (timeBased !== false) {
		this.timer = setTimeout(this.closeSerial.bind(this),
		    this.triggerInterval);
	}
	this.serial = utils.nextSerial();
	this.zones = {};
};

UpdateStream.prototype.openZone = function (zone, cb) {
	assert.string(zone);
	assert.func(cb);
	assert.notStrictEqual(this.serial, undefined);

	if (this.zones[zone]) {
		cb(null, this.zones[zone]);
		return;
	}

	var self = this;
	this.client.get('zone:' + zone + ':latest', function (err, val) {
		var prevSerial = (!err && val !== null) ?
		    parseInt(val, 10) : undefined;

		var z = new Zone({
			client: self.client,
			name: zone,
			fromSerial: prevSerial,
			toSerial: self.serial,
			log: self.log
		});

		self.zones[zone] = z;
		cb(null, z);
	});
};

UpdateStream.prototype.closeSerial = function (cb) {
	assert.number(this.serial);
	assert.optionalFunc(cb);

	var self = this;

	var serial = this.serial;
	this.serial = undefined;
	this.log.trace({serial: serial}, 'committing changes');

	var zones = [];
	Object.keys(this.zones).forEach(function (k) {
		zones.push(self.zones[k]);
	});
	this.zones = {};

	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	vasync.forEachParallel({
		func: doCommit,
		inputs: zones
	}, function (err, res) {
		if (err) {
			self.emit('error', err);
			if (cb)
				cb(err);
			return;
		}

		self.emit('serial', serial);
		if (cb)
			cb(null, serial);
	});

	function doCommit(zone, ccb) {
		if (zone.isDirty()) {
			zone.commit(ccb);
		} else {
			ccb(null);
		}
	}
};

UpdateStream.prototype._write = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.string(vm.uuid, 'vm.uuid');
	assert.arrayOfString(vm.services, 'vm.services');
	assert.arrayOfObject(vm.nics, 'vm.nics');
	assert.string(vm.operation, 'vm.operation');

	var self = this;

	/*
	 * Write the last_visit timestamp which can be used for debugging, or
	 * by the ReaperStream.
	 */
	var now = Math.round((new Date()).getTime() / 1000);
	this.client.hset('vm:' + vm.uuid, 'last_visit', String(now));

	var entries = [];
	vm.nics.forEach(function (nic) {
		if (nic.ips === undefined)
			nic.ips = [nic.ip];
		nic.ips.forEach(function (ipmask) {
			var ip = ipmask.split('/')[0];
			assert.arrayOfString(nic.zones, 'vm.nics.zones');
			nic.zones.forEach(function (zone) {
				entries.push({
					type: 'instance',
					ip: ip,
					zone: zone
				});
				vm.services.forEach(function (svc) {
					entries.push({
						type: 'service',
						ip: ip,
						zone: zone,
						service: svc
					});
				});
			});
		});
	});

	/*
	 * Build the full set of records in zones that this VM should be
	 * responsible for. This is the set we want to get to.
	 */
	var zones = {};
	entries.forEach(function (ent) {
		var addrType;
		if (net.isIPv4(ent.ip)) {
			addrType = 'A';
		} else if (net.isIPv6(ent.ip)) {
			addrType = 'AAAA';
		} else {
			throw (new Error('Unknown address type: ' + ent.ip));
		}
		ent.addrType = addrType;

		if (!zones[ent.zone])
			zones[ent.zone] = {};

		if (ent.type === 'instance') {
			addInstance(zones, vm, ent, self.config);
		} else if (ent.type === 'service') {
			addService(zones, vm, ent, self.config);
		}
	});

	/*
	 * Now fetch the existing set of records from the last time we saw this
	 * VM, if any.
	 */
	this.client.hget('vm:' + vm.uuid, 'last_recs', function (err, val) {
		if (err || val === null)
			val = {};
		else
			val = JSON.parse(val);

		/*
		 * Find any records we generated last time that we should not
		 * generate this time, add them to the list to be removed.
		 */
		var rmZones = {};
		Object.keys(val).forEach(function (zone) {
			var z = val[zone];
			var z2 = zones[zone];
			if (z2 === undefined) {
				rmZones[zone] = z;
				return;
			}
			Object.keys(z).forEach(function (name) {
				if (z2[name] === undefined) {
					if (rmZones[zone] === undefined)
						rmZones[zone] = {};
					rmZones[zone][name] = z[name];
				}
			});
		});

		if (vm.operation === 'add') {
			self.rmEntries(rmZones, function (err2) {
				self.setEntries(zones, function (err3) {
					if (err2 || err3) {
						cb(err2 || err3);
						return;
					}
					self.client.hset('vm:' + vm.uuid,
					    'last_recs',
					    JSON.stringify(zones), cb);
				});
			});

		} else if (vm.operation === 'remove') {
			self.rmEntries(val, function (err2) {
				self.rmEntries(zones, function (err3) {
					if (err2 || err3) {
						cb(err2 || err3);
						return;
					}
					self.client.hset('vm:' + vm.uuid,
					    'last_recs', '{}', cb);
				});
			});

		} else {
			cb(new Error('Bad value for operation: ' +
			    vm.operation));
		}
	});
};

function dnsify(str) {
	return (str.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
}

function addInstance(zones, vm, ent, config) {
	function addName(name) {
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		recs.push({
			constructor: ent.addrType,
			args: [ent.ip]
		});
		var hasTxt = false;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].constructor === 'TXT') {
				hasTxt = true;
				break;
			}
		}
		if (!hasTxt) {
			recs.push({
				constructor: 'TXT',
				args: [vm.uuid]
			});
		}
	}

	var uuidName = vm.uuid + '.inst.' + vm.owner.uuid;
	addName(uuidName);
	if (config.use_login)
		addName(vm.uuid + '.inst.' + dnsify(vm.owner.login));
	if (config.use_alias)
		addName(dnsify(vm.alias) + '.inst.' + vm.owner.uuid);
	if (config.use_login && config.use_alias)
		addName(dnsify(vm.alias) + '.inst.' + dnsify(vm.owner.login));

	var rev = utils.reverseZoneIp(ent.ip);
	if (!zones[rev.zone])
		zones[rev.zone] = {};
	if (!zones[rev.zone][rev.name])
		zones[rev.zone][rev.name] = [];
	zones[rev.zone][rev.name].push({
		constructor: 'PTR',
		args: [uuidName + '.' + ent.zone]
	});
}

function addService(zones, vm, ent, config) {
	function addName(name) {
		if (!zones[ent.zone][name])
			zones[ent.zone][name] = [];
		var recs = zones[ent.zone][name];
		recs.push({
			constructor: ent.addrType,
			args: [ent.ip],
			src: vm.uuid
		});
		var hasTxt = false;
		for (var i = 0; i < recs.length; ++i) {
			if (recs[i].constructor === 'TXT' &&
			    recs[i].args[0] === vm.uuid) {
				hasTxt = true;
				break;
			}
		}
		if (!hasTxt) {
			recs.push({
				constructor: 'TXT',
				args: [vm.uuid],
				src: vm.uuid
			});
		}
	}
	addName(ent.service + '.svc.' + vm.owner.uuid);
	if (config.use_login)
		addName(ent.service + '.svc.' + dnsify(vm.owner.login));
}

UpdateStream.prototype.setEntries = function (zones, cb) {
	var self = this;

	vasync.forEachPipeline({
		func: doZone,
		inputs: Object.keys(zones)
	}, function (err, res) {
		cb(err);
	});

	function doZone(zname, zcb) {
		var z = zones[zname];

		self.openSerial();

		self.openZone(zname, function (err, zone) {
			vasync.forEachPipeline({
				func: doEntry,
				inputs: Object.keys(z)
			}, zcb);

			function doEntry(name, ecb) {
				var ars = z[name];
				var src;
				if (ars[0] && ars[0].src)
					src = ars[0].src;

				var doRec = zone.addObj.bind(zone, name);

				zone.list(name, function (err2, recs) {
					recs = recs.filter(function (r) {
						return (!src || r.src === src);
					});
					var changed = !recSetMatch(ars, recs);
					if (changed)
						doClear();
					else
						ecb(null);
				});

				function doClear() {
					zone.clear(name, src, function (err2) {
						vasync.forEachPipeline({
							func: doRec,
							inputs: ars
						}, ecb);
					});
				}
			}
		});
	}
};

UpdateStream.prototype.rmEntries = function (zones, cb) {
	var self = this;

	vasync.forEachPipeline({
		func: doZone,
		inputs: Object.keys(zones)
	}, function (err, res) {
		cb(err);
	});

	function doZone(zname, zcb) {
		var z = zones[zname];

		self.openSerial();

		self.openZone(zname, function (err, zone) {
			vasync.forEachPipeline({
				func: doEntry,
				inputs: Object.keys(z)
			}, zcb);

			function doEntry(name, ecb) {
				var rmrs = z[name];
				var src;
				if (rmrs[0] && rmrs[0].src)
					src = rmrs[0].src;
				zone.list(name, function (err2, recs) {
					recs = recs.filter(function (r) {
						return (!src || r.src === src);
					});
					vasync.forEachPipeline({
						func: doRec,
						inputs: recs
					}, ecb);
				});

				function doRec(rec, rcb) {
					var ids = [];
					for (var i = 0; i < rmrs.length; ++i) {
						var rmr = rmrs[i];
						if (recMatch(rec, rmr)) {
							ids.push(rec.id);
							break;
						}
					}
					vasync.forEachPipeline({
						func: zone.remove.bind(zone,
						    name),
						inputs: ids
					}, rcb);
				}
			}
		});
	}
};

function recSetMatch(set1, set2) {
	for (var i = 0; i < set1.length; ++i) {
		var found = false;
		for (var j = 0; j < set2.length; ++j) {
			if (recMatch(set1[i], set2[j])) {
				found = true;
				break;
			}
		}
		if (!found)
			return (false);
	}
	return (true);
}

function recFind(set, rec) {
	for (var i = 0; i < set.length; ++i) {
		if (recMatch(rec, set[i]))
			return (true);
	}
	return (false);
}

function recMatch(rec1, rec2) {
	return ((rec1.id && rec2.id && rec1.id === rec2.id) || (
	    (rec1.constructor === rec2.constructor) &&
	    (JSON.stringify(rec1.args) === JSON.stringify(rec2.args))));
}

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
			cb(new Error('Record not found'));
			return;
		}

		self.log.trace('remove %s', id);
		self.rms.push({name: name, record: rec});
		cb(null);
	});
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

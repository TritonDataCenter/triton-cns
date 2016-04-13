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
var EventEmitter = require('events').EventEmitter;

var consts = require('./consts');
var DEFAULT_TRIGGER_INT = consts.DEFAULT_TRIGGER_INT;

var Zone = require('./zone-builder');
var buildZonesFromVm = require('./vm-to-zones');

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
	this.busy = undefined;
	this.vmsToCommit = {};

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

UpdateStream.prototype.saveNSRecords = function (serial, zs, cb) {
	var self = this;
	this.log.trace({zones: zs, serial: serial}, 'saving ns records');
	vasync.forEachPipeline({
		func: doZone,
		inputs: zs
	}, cb);
	function doZone(z, zcb) {
		var recs = [];

		var conf = self.config.forward_zones[z];
		if (conf === undefined && z.match(/\.arpa$/))
			conf = self.config.reverse_zones;

		if (conf.hidden_primary !== true) {
			recs.push({
			    constructor: 'NS',
			    args: [self.config.my_name]
			});
		}

		var peers = conf.peers || [];
		for (var i = 0; i < peers.length; ++i) {
			recs.push({
			    constructor: 'NS',
			    args: [peers[i]]
			});
		}

		self.client.set('nsrecs:' + z + ':' + serial,
		    JSON.stringify(recs), zcb);
	}
};

UpdateStream.prototype.closeSerial = function (cb) {
	assert.optionalFunc(cb);
	if (this.serial === undefined) {
		var e = new Error('UpdateStream cannot close serial when ' +
		    'no serial is currently open');
		e.stream = this;
		if (cb)
			cb(e);
		return;
	}

	assert.number(this.serial);
	var self = this;
	/*
	 * Only one write or commit operation can be running at a time, or
	 * else we can commit a partly-generated set of records and other
	 * horrible things.
	 *
	 * We create the .busy EventEmitter which will fire 'done' when the
	 * other write/commit that's already running has finished.
	 */
	if (this.busy) {
		var oldSerial = self.serial;
		this.log.trace({serial: oldSerial}, 'deferring commit, busy');
		this.busy.once('done', function () {
			if (self.serial === oldSerial) {
				/* Retry if we're still on the same serial. */
				self.closeSerial(cb);

			} else if (cb) {
				/*
				 * If serial is different, or unset now, then
				 * this old serial we started with has already
				 * been committed. Run the callback.
				 */
				cb(null, oldSerial);
			}
		});
		return;
	}
	this.busy = new EventEmitter();

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

	var committed = [];
	vasync.pipeline({
		funcs: [
		    doZoneCommits,
		    doSaveVMRecords,
		    doSaveNSRecords
		]
	}, function (err) {
		if (err) {
			self.emit('error', err);
			if (cb)
				cb(err);
			self._busyDone();
			return;
		}
		self.emit('serial', serial);
		if (cb)
			cb(null, serial);
		self._busyDone();
	});

	function doZoneCommits(_, scb) {
		vasync.forEachParallel({
			func: commitZone,
			inputs: zones
		}, scb);
	}

	function commitZone(zone, ccb) {
		if (zone.isDirty()) {
			committed.push(zone.name);
			zone.commit(ccb);
		} else {
			ccb(null);
		}
	}

	function doSaveVMRecords(_, scb) {
		var jobs = [];

		var vms = self.vmsToCommit;
		self.vmsToCommit = {};
		var uuids = Object.keys(vms);
		for (var i = 0; i < uuids.length; ++i) {
			var vm = vms[uuids[i]];
			if (vm.last_recs) {
				jobs.push(['vm:' + uuids[i], 'last_recs',
				    JSON.stringify(vm.last_recs)]);
			}
		}

		vasync.forEachParallel({
			func: function (job, ccb) {
				job.push(ccb);
				self.client.hset.apply(self.client, job);
			},
			inputs: jobs
		}, scb);
	}

	function doSaveNSRecords(_, scb) {
		self.saveNSRecords(serial, committed, scb);
	}
};

/* See above inside closeSerial() for more info. */
UpdateStream.prototype._busyDone = function () {
	assert.ok(this.busy);
	var busy = this.busy;
	this.busy = undefined;
	busy.emit('done');
};

UpdateStream.prototype._write = function (vm, enc, writecb) {
	assert.object(vm, 'vm');
	assert.string(vm.uuid, 'vm.uuid');
	assert.arrayOfObject(vm.services, 'vm.services');
	assert.arrayOfObject(vm.nics, 'vm.nics');
	assert.bool(vm.listInstance, 'vm.listInstance');
	assert.bool(vm.listServices, 'vm.listServices');

	var self = this;
	/*
	 * Only one write or commit operation can be running at a time, or
	 * else we can commit a partly-generated set of records and other
	 * horrible things.
	 */
	if (this.busy) {
		this.busy.once('done', function () {
			self._write(vm, enc, writecb);
		});
		return;
	}
	this.busy = new EventEmitter();
	var cb = function () {
		self._busyDone();
		return (writecb.apply(this, arguments));
	};

	/*
	 * Write the last_visit timestamp which can be used for debugging, or
	 * by the ReaperStream.
	 */
	var now = Math.round((new Date()).getTime() / 1000);
	this.client.hset('vm:' + vm.uuid, 'last_visit', String(now));

	/* Generate the zones and records for this VM. */
	var zones = buildZonesFromVm(vm, self.config, self.log);

	/* Record debugging info to trace where changes come from. */
	var zoneCounts = {};
	Object.keys(zones).forEach(function (z) {
		zoneCounts[z] = Object.keys(zones[z]).length;
	});
	var historyRec = {
		vm: vm.uuid,
		why: vm.reasons,
		l_s: vm.listServices,
		l_i: vm.listInstance,
		svcs: vm.services,
		c: zoneCounts,
		o: vm.origin
	};
	this.log.debug({info: historyRec}, 'updating vm');
	this.client.hget('vm:' + vm.uuid, 'verbose', function (err, val) {
		if (err || val === null)
			return;
		if (val === 'true') {
			var names = {};
			Object.keys(zones).forEach(function (z) {
				names[z] = Object.keys(zones[z]);
			});
			self.log.debug({vm: vm, zones: names}, 'updating vm');
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

		var vmc = self.vmsToCommit[vm.uuid];
		if (vmc && vmc.last_recs)
			val = vmc.last_recs;
		if (vmc === undefined)
			vmc = (self.vmsToCommit[vm.uuid] = {});

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

		if (!vm.listInstance && !vm.listServices) {
			self.rmEntries(val, {}, function (err2) {
				if (err2) {
					cb(err2);
					return;
				}
				vmc.last_recs = {};
				cb(null);
			});
		} else {
			self.rmEntries(rmZones, {}, function (err2) {
				self.setEntries(zones, function (err3) {
					if (err2 || err3) {
						cb(err2 || err3);
						return;
					}
					vmc.last_recs = zones;
					cb(null);
				});
			});
		}
	});
};

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

				var addRec = zone.addObj.bind(zone, name);
				var rmRec = zone.removeObj.bind(zone, name);
				var diff;

				zone.list(name, function (err2, recs) {
					recs = recs.filter(function (r) {
						return (!src || r.src === src);
					});

					diff = utils.recSetDiff(recs, ars);

					var changed = (diff.add.length > 0 ||
					    diff.remove.length > 0);
					if (changed)
						doRemoves();
					else
						ecb(null);
				});

				function doRemoves() {
					vasync.forEachPipeline({
						func: rmRec,
						inputs: diff.remove
					}, doAdds);
				}

				function doAdds(err2) {
					if (err2) {
						ecb(err2);
						return;
					}
					vasync.forEachPipeline({
						func: addRec,
						inputs: diff.add
					}, ecb);
				}
			}
		});
	}
};

UpdateStream.prototype.rmEntries = function (zones, opts, cb) {
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
						if (utils.recMatch(rec, rmr)) {
							ids.push(rec.id);
							break;
						}
					}

					vasync.forEachPipeline({
						func: rmId,
						inputs: ids
					}, rcb);
				}

				function rmId(id, idcb) {
					zone.remove(name, id,
					    function (err2) {
						var nm = 'RecordNotFound';
						if (err2 && err2.name === nm &&
						    opts.ignoreNotFound) {
							idcb(null);
							return;
						}
						idcb(err2);
					});
				}
			}
		});
	}
};

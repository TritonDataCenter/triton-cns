/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = FlagFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');

var consts = require('./consts');
var SERVICES_TAG = consts.SERVICES_TAG;
var DOCKER_PREFIX = consts.DOCKER_PREFIX;
var USER_EN_FLAG = consts.USER_EN_FLAG;
var INST_EN_FLAG = consts.INST_EN_FLAG;
var INST_EN_TAG = consts.INST_EN_TAG;
var INST_PTR_TAG = consts.INST_PTR_TAG;

/*JSSTYLED*/
var PTR_REGEX = /^[a-z0-9][a-z0-9\-]{0,62}(?:\.[a-z0-9][a-z0-9\-]{0,62})*$/i;

/*
 * The FlagFilter transform stream takes in a VM object that has been annotated
 * with "owner" and "server" objects (by UfdsFilter, CnFilter and NetFilter),
 * and determines whether the object will result in the addition or removal of
 * DNS records.
 *
 * It also processes the SERVICES_TAG metadata to decide which services the
 * given VM record will be listed in. This is not so easy to decouple, as
 * some flags will result in the services list being emptied without the whole
 * VM being removed from DNS.
 */
function FlagFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'FlagFilter'});

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(FlagFilter, stream.Transform);

FlagFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.object(vm.owner, 'vm.owner');
	assert.object(vm.server, 'vm.server');
	assert.string(vm.uuid, 'vm.uuid');
	assert.object(vm.tags, 'vm.tags');
	assert.object(vm.customer_metadata, 'vm.customer_metadata');

	vm.services = [];
	if (vm.tags) {
		var svcs = vm.tags[SERVICES_TAG];
		if (svcs === undefined)
			svcs = vm.tags[DOCKER_PREFIX + SERVICES_TAG];
		if (svcs !== undefined) {
			svcs.split(',').forEach(function (svcTag) {
				/*
				 * For future-proofing purposes, we grab just
				 * the part before the first colon of the tag.
				 * If we need to add options in future they
				 * will be after this colon.
				 */
				svcTag = svcTag.trim().split(':');
				if (svcTag[0].length > 0)
					vm.services.push(svcTag[0]);
			});
		}
	}

	/*
	 * A zone that isn't running, or is on a CN that is not running, or
	 * a zone that has its metadata status flag set to non-"up" should
	 * be excluded from any services, but will still have instance records.
	 *
	 * "CN that is not running" includes CNs that have not heartbeated in
	 * the last 30 seconds, and CNs that have only booted up in the last
	 * 2 minutes.
	 */
	if (vm.customer_metadata[INST_EN_FLAG] !== undefined &&
	    vm.customer_metadata[INST_EN_FLAG] !== 'up') {
		vm.services = [];

	} else if (vm.server.status !== 'running' ||
	    vm.server.heartbeat_age > 60000 ||
	    vm.server.last_boot_age < 120000) {
		vm.services = [];

	} else if (vm.state !== 'running') {
		vm.services = [];
	}

	vm.operation = 'add';

	/* Lowest priority: user enable flags. */
	if (!vm.owner[USER_EN_FLAG] ||
	    vm.owner[USER_EN_FLAG] === 'false') {
		this.log.trace({vm: vm.uuid},
		    'vm disabled, user flag unset');
		vm.operation = 'remove';

	} else if (!vm.owner.approved_for_provisioning ||
	    vm.owner.approved_for_provisioning === 'false') {
		this.log.trace({vm: vm.uuid},
		    'vm disabled, user not approved');
		vm.operation = 'remove';
	}

	/*
	 * Enable all VMs that have a PTR tag, even if their owner doesn't
	 * have CNS enabled globally.
	 */
	if (vm.tags && vm.tags[INST_PTR_TAG] &&
	    PTR_REGEX.test(vm.tags[INST_PTR_TAG])) {
		this.log.trace({vm: vm.uuid},
		    'vm has ptr tag, forced to enable');
		vm.ptrname = vm.tags[INST_PTR_TAG];
		vm.operation = 'add';

	} else if (vm.tags && vm.tags[DOCKER_PREFIX + INST_PTR_TAG] &&
	    PTR_REGEX.test(vm.tags[DOCKER_PREFIX + INST_PTR_TAG])) {
		this.log.trace({vm: vm.uuid},
		    'vm has ptr tag, forced to enable');
		vm.ptrname = vm.tags[DOCKER_PREFIX + INST_PTR_TAG];
		vm.operation = 'add';
	}

	/*
	 * Finally, the top priority: explicit VM disable tags, and VMs that
	 * have been destroyed.
	 */
	if (vm.tags && vm.tags[INST_EN_TAG] !== undefined &&
	    vm.tags[INST_EN_TAG] !== false) {
		vm.operation = 'remove';

	} else if (vm.tags &&
	    vm.tags[DOCKER_PREFIX + INST_EN_TAG] !== undefined &&
	    vm.tags[DOCKER_PREFIX + INST_EN_TAG] !== false) {
		vm.operation = 'remove';

	} else if (vm.destroyed || vm.state === 'destroyed' ||
	    vm.state === 'failed') {
		this.log.trace({vm: vm.uuid},
		    'vm disabled, marked as destroyed');
		vm.operation = 'remove';
	}

	this.push(vm);
	cb();
};

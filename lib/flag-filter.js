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
	var svcIdx = {};
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
				if (svcTag[0].length > 0) {
					if (svcIdx[svcTag[0]] === undefined) {
						svcIdx[svcTag[0]] = {
							name: svcTag[0],
							ports: []
						};
						vm.services.push(
						    svcIdx[svcTag[0]]);
					}
					var port;
					if (svcTag[1] && svcTag[1].length > 0)
						port = parseInt(svcTag[1], 10);
					if (port && isFinite(port))
						svcIdx[svcTag[0]].ports.
						    push(port);
				}
			});
		}
	}

	/* Set default: list in both instance and service records. */
	vm.listInstance = true;
	vm.listServices = true;
	/*
	 * vm.reasons is an array of strings identifying the reasoning for
	 * why the two flags above are set as they are.
	 */
	vm.reasons = [];

	/*
	 * A zone that isn't running, or is on a CN that is not running, or
	 * a zone that has its metadata status flag set to non-"up" should
	 * be excluded from any services, but will still have instance records.
	 */
	if (vm.customer_metadata[INST_EN_FLAG] !== undefined &&
	    vm.customer_metadata[INST_EN_FLAG] !== 'up') {
		vm.listServices = false;
		vm.reasons.push('inst_en_flag');

	} else if (vm.server.down) {
		/* For the definition of "down", see cutServerObj(). */
		vm.listServices = false;
		vm.reasons.push('cn_down');

	} else if (vm.state !== 'running') {
		vm.listServices = false;
		vm.reasons.push('vm_down');
	}

	/* Lowest priority: user enable flags. */
	if (!vm.owner[USER_EN_FLAG] ||
	    vm.owner[USER_EN_FLAG] === 'false') {
		vm.listServices = false;
		vm.listInstance = false;
		vm.reasons.push('user_en_flag');

	} else if (!vm.owner.approved_for_provisioning ||
	    vm.owner.approved_for_provisioning === 'false') {
		vm.listServices = false;
		vm.listInstance = false;
		vm.reasons.push('user_not_approved');
	}

	/*
	 * Enable all VMs that have a PTR tag, even if their owner doesn't
	 * have CNS enabled globally.
	 */
	if (vm.tags && vm.tags[INST_PTR_TAG] &&
	    PTR_REGEX.test(vm.tags[INST_PTR_TAG])) {
		vm.listInstance = true;
		vm.reasons.push('ptr');
		vm.ptrname = vm.tags[INST_PTR_TAG];

	} else if (vm.tags && vm.tags[DOCKER_PREFIX + INST_PTR_TAG] &&
	    PTR_REGEX.test(vm.tags[DOCKER_PREFIX + INST_PTR_TAG])) {
		vm.listInstance = true;
		vm.reasons.push('ptr');
		vm.ptrname = vm.tags[DOCKER_PREFIX + INST_PTR_TAG];
	}

	/*
	 * Finally, the top priority: explicit VM disable tags, and VMs that
	 * have been destroyed.
	 */
	if (vm.tags && vm.tags[INST_EN_TAG] !== undefined &&
	    vm.tags[INST_EN_TAG] !== false) {
		vm.listServices = false;
		vm.listInstance = false;
		vm.reasons.push('inst_en_tag');

	} else if (vm.tags &&
	    vm.tags[DOCKER_PREFIX + INST_EN_TAG] !== undefined &&
	    vm.tags[DOCKER_PREFIX + INST_EN_TAG] !== false &&
	    vm.tags[DOCKER_PREFIX + INST_EN_TAG] !== 'false') {
		vm.listServices = false;
		vm.listInstance = false;
		vm.reasons.push('inst_en_tag');

	} else if (vm.destroyed || vm.state === 'destroyed' ||
	    vm.state === 'failed') {
		vm.listServices = false;
		vm.listInstance = false;
		vm.reasons.push('destroyed');
	}

	this.push(vm);
	cb();
};

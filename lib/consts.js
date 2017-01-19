/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = {
	VERSION: '0.1.0',
	TTL: 30,
	NS_TTL: 3600,
	DEFAULT_TRIGGER_INT: 10000,
	DEFAULT_VMAPI_LIMIT: 100,
	DEFAULT_MIN_NOTIFY_INT: 5000,
	DOCKER_PREFIX: 'docker:label:',
	SERVICES_TAG: 'triton.cns.services',
	USER_EN_FLAG: 'triton_cns_enabled',
	INST_EN_TAG: 'triton.cns.disable',
	INST_EN_FLAG: 'triton.cns.status',
	INST_ACME_KEY: 'triton.cns.acme-challenge',
	INST_PTR_TAG: 'triton.cns.reverse_ptr'
};

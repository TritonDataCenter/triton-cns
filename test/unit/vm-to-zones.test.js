/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var test = require('./test-namer')('vm-to-zones');
var util = require('util');
var bunyan = require('bunyan');

var utils = require('../../lib/utils');

var buildZonesFromVm = require('../../lib/vm-to-zones');

var log = bunyan.createLogger({name: 'cns'});

test('basic single container', function (t) {
	var config = {
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']), ['abc123.inst.def432',
	    'default-fabric.abc123.inst.def432', 'abc123.cmon']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['abc123.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var cmon = zones['foo']['abc123.cmon'];
	t.deepEqual(cmon, [
	    {constructor: 'CNAME', args: ['cmon.foo']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['abc123.inst.def432.foo']}
	]);

	t.end();
});

test('cloudapi instance', function (t) {
	var config = {
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    services: [ { name: 'cloudapi', ports: [] } ],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'admin'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(), [
	    'abc123.cmon', 'abc123.inst.def432', 'cloudapi',
	    'cloudapi.svc.def432', 'default-fabric.abc123.inst.def432',
	    'default-fabric.cloudapi.svc.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['cloudapi'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4'], src: 'abc123'},
	    {constructor: 'TXT', args: ['abc123'], src: 'abc123'}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['abc123.inst.def432.foo']}
	]);

	t.end();
});

test('with use_alias', function (t) {
	var config = {
	    use_alias: true,
	    forward_zones: {
		'foo': {
		    networks: ['*'],
		    proxy_addr: '9.9.9.9',
		    proxy_networks: ['aaa1111']
		}
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: {
			uuid: 'abcd1234',
			name: 'SDC-Customer-Public-Pool-72.2.118.0/23',
			owner_uuids: ['def432']
		    }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.def432',
	    'sdc-customer-public-pool-72-2-118-0-23.abc123.inst.def432',
	    'sdc-customer-public-pool-72-2-118-0-23.test.inst.def432',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['test.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.def432.foo']}
	]);

	t.end();
});

test('with use_login', function (t) {
	var config = {
	    use_login: true,
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['abc123'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['abc123.inst.bar'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['abc123.inst.bar.foo']}
	]);

	t.end();
});

test('with use_alias and use_login', function (t) {
	var config = {
	    use_alias: true,
	    use_login: true,
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432',
	    'default-fabric.abc123.inst.bar',
	    'default-fabric.abc123.inst.def432',
	    'default-fabric.test.inst.bar',
	    'default-fabric.test.inst.def432', 'test.inst.bar',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['test.inst.bar'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.bar.foo']}
	]);

	t.end();
});

test('using a PTR name', function (t) {
	var config = {
	    use_alias: true,
	    use_login: true,
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    ptrname: 'test.something.com',
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.something.com']}
	]);

	t.end();
});

test('multi-zone', function (t) {
	var config = {
	    use_alias: true,
	    use_login: true,
	    forward_zones: {
		'foo': { networks: ['*'] },
		'bar': { networks: ['aaaaaa'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		},
		{
		    ip: '3.2.1.4',
		    zones: ['bar'],
		    network: { name: 'external', owner_uuids: [] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(),
	    ['1.2.3.in-addr.arpa', '3.2.1.in-addr.arpa', 'bar', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432',
	    'default-fabric.abc123.inst.bar',
	    'default-fabric.abc123.inst.def432', 'default-fabric.test.inst.bar',
	    'default-fabric.test.inst.def432', 'test.inst.bar',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['bar']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432',
	    'test.inst.bar', 'test.inst.def432']);

	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);
	t.deepEqual(Object.keys(zones['1.2.3.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['test.inst.bar'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.bar.foo']}
	]);
	var rev2 = zones['1.2.3.in-addr.arpa']['4'];
	t.deepEqual(rev2, [
	    {constructor: 'PTR', args: ['test.inst.bar.bar']}
	]);

	t.end();
});

test('multi-zone, single PTRs', function (t) {
	var config = {
	    use_alias: true,
	    use_login: true,
	    forward_zones: {
		'foo': { networks: ['*'] },
		'bar': { networks: ['bbbbb'] },
		'baz': { networks: ['aaaaa'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo', 'bar'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		},
		{
		    ip: '3.2.1.4',
		    zones: ['baz'],
		    network: { name: 'external', owner_uuids: [] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(),
	    ['1.2.3.in-addr.arpa', '3.2.1.in-addr.arpa', 'bar', 'baz', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432',
	    'default-fabric.abc123.inst.bar',
	    'default-fabric.abc123.inst.def432', 'default-fabric.test.inst.bar',
	    'default-fabric.test.inst.def432', 'test.inst.bar',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['bar']).sort(),
	    ['abc123.cmon', 'abc123.inst.bar', 'abc123.inst.def432',
	    'test.inst.bar', 'test.inst.def432']);

	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);
	t.deepEqual(Object.keys(zones['1.2.3.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['test.inst.bar'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.bar.foo']}
	]);
	var rev2 = zones['1.2.3.in-addr.arpa']['4'];
	t.deepEqual(rev2, [
	    {constructor: 'PTR', args: ['test.inst.bar.baz']}
	]);

	t.end();
});

test('multi-zone, shortest zone priority PTR', function (t) {
	var config = {
	    use_alias: true,
	    use_login: true,
	    forward_zones: {
		'foobarbaz': { networks: ['*'] },
		'foobar': { networks: ['aaaaaa'] },
		'baz': { networks: ['bbbbbb'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432',
		login: 'bar'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foobar', 'foobarbaz', 'baz'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);

	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.bar.baz']}
	]);

	t.end();
});

test('service with srvs', function (t) {
	var config = {
	    use_alias: true,
	    forward_zones: {
		'foo': { networks: ['*'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [
	        { name: 'svc1', ports: [1234, 1235] }
	    ],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.cmon', 'abc123.inst.def432',
	    'default-fabric.abc123.inst.def432',
	    'default-fabric.svc1.svc.def432',
	    'default-fabric.test.inst.def432', 'svc1.svc.def432',
	    'test.inst.def432']);

	var fwd = zones['foo']['test.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);

	var svc = zones['foo']['svc1.svc.def432'];
	t.deepEqual(svc, [
	    {constructor: 'A', args: ['1.2.3.4'], src: 'abc123'},
	    {constructor: 'TXT', args: ['abc123'], src: 'abc123'},
	    {constructor: 'SRV', args: ['test.inst.def432.foo', 1234],
	        src: 'abc123'},
	    {constructor: 'SRV', args: ['test.inst.def432.foo', 1235],
	        src: 'abc123'}
	]);

	t.end();
});

test('acme challenge support', function (t) {
	var config = {
	    use_alias: true,
	    forward_zones: {
		'foo': { networks: ['aaaaa'] }
	    },
	    reverse_zones: {}
	};
	var challenge = 'OL92GcAcYP0DTCTVwMU46dpu73dAhu5XD6ahQiDg54M';
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [
	        { name: 'svc1', ports: [1234] }
	    ],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    customer_metadata: {
		'triton.cns.acme-challenge': challenge
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['_acme-challenge.abc123.inst.def432',
	    '_acme-challenge.svc1.svc.def432',
	    '_acme-challenge.test.inst.def432', 'abc123.cmon',
	    'abc123.inst.def432', 'svc1.svc.def432', 'test.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['test.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var acme = zones['foo']['_acme-challenge.test.inst.def432'];
	t.deepEqual(acme, [
	    {constructor: 'TXT', args: [challenge]}
	]);
	acme = zones['foo']['_acme-challenge.svc1.svc.def432'];
	t.deepEqual(acme, [
	    {constructor: 'TXT', args: [challenge], src: 'abc123'}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.def432.foo']}
	]);

	t.end();
});

test('acme challenge on unlisted service (TRITON-599)', function (t) {
	var config = {
	    use_alias: true,
	    forward_zones: {
		'foo': { networks: ['aaaaa'] }
	    },
	    reverse_zones: {}
	};
	var challenge = 'OL92GcAcYP0DTCTVwMU46dpu73dAhu5XD6ahQiDg54M';
	var vm = {
	    uuid: 'abc123',
	    alias: 'test',
	    services: [
	        { name: 'svc1', ports: [1234] }
	    ],
	    listInstance: true,
	    listServices: false,
	    owner: {
		uuid: 'def432'
	    },
	    customer_metadata: {
		'triton.cns.acme-challenge': challenge
	    },
	    nics: [
		{
		    ips: ['1.2.3.4'],
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(), ['3.2.1.in-addr.arpa', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['_acme-challenge.abc123.inst.def432',
	    '_acme-challenge.svc1.svc.def432',
	    '_acme-challenge.test.inst.def432', 'abc123.cmon',
	    'abc123.inst.def432', 'svc1.svc.def432', 'test.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['svc1.svc.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'TXT', args: ['verifying:abc123'], src: 'abc123'}
	]);
	var acme = zones['foo']['_acme-challenge.test.inst.def432'];
	t.deepEqual(acme, [
	    {constructor: 'TXT', args: [challenge]}
	]);
	acme = zones['foo']['_acme-challenge.svc1.svc.def432'];
	t.deepEqual(acme, [
	    {constructor: 'TXT', args: [challenge], src: 'abc123'}
	]);
	var rev = zones['3.2.1.in-addr.arpa']['4'];
	t.deepEqual(rev, [
	    {constructor: 'PTR', args: ['test.inst.def432.foo']}
	]);

	t.end();
});

test('cmon everywhere', function (t) {
	var config = {
	    forward_zones: {
		'foo': { networks: ['bbbbbb'] },
		'bar': { networks: ['aaaaaa'] }
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    services: [],
	    listInstance: true,
	    listServices: false,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa', 'bar']);

	t.deepEqual(Object.keys(zones['foo']), ['abc123.inst.def432',
	    'abc123.cmon']);
	t.deepEqual(Object.keys(zones['bar']), ['abc123.cmon']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var cmon = zones['foo']['abc123.cmon'];
	t.deepEqual(cmon, [
	    {constructor: 'CNAME', args: ['cmon.foo']}
	]);

	cmon = zones['bar']['abc123.cmon'];
	t.deepEqual(cmon, [
	    {constructor: 'CNAME', args: ['cmon.bar']}
	]);

	t.end();
});

test('reverse proxy zone - wildcard', function (t) {
	var config = {
	    forward_zones: {
		'foo': {
		    networks: ['*'],
		    proxy_addr: '9.9.9.9',
		    proxy_networks: ['*']
		}
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: { name: 'Default-Fabric', owner_uuids: ['def432'] }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo']);

	t.deepEqual(Object.keys(zones['foo']), ['abc123.inst.def432',
	    'default-fabric.abc123.inst.def432', 'abc123.cmon']);

	var fwd = zones['foo']['abc123.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['9.9.9.9']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var cmon = zones['foo']['abc123.cmon'];
	t.deepEqual(cmon, [
	    {constructor: 'CNAME', args: ['cmon.foo']}
	]);

	t.end();
});

test('reverse proxy zone - specific net', function (t) {
	var config = {
	    forward_zones: {
		'foo': {
		    networks: ['*'],
		    proxy_addr: '9.9.9.9',
		    proxy_networks: ['ddd111']
		}
	    },
	    reverse_zones: {}
	};
	var vm = {
	    uuid: 'abc123',
	    services: [],
	    listInstance: true,
	    listServices: true,
	    owner: {
		uuid: 'def432'
	    },
	    nics: [
		{
		    ip: '1.2.3.4',
		    zones: ['foo'],
		    network: {
			uuid: 'ddd111',
			name: 'Default-Fabric',
			owner_uuids: ['def432']
		    }
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo']);

	t.deepEqual(Object.keys(zones['foo']), ['abc123.inst.def432',
	    'default-fabric.abc123.inst.def432', 'abc123.cmon']);

	var fwd = zones['foo']['abc123.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['9.9.9.9']},
	    {constructor: 'TXT', args: ['abc123']}
	]);
	var cmon = zones['foo']['abc123.cmon'];
	t.deepEqual(cmon, [
	    {constructor: 'CNAME', args: ['cmon.foo']}
	]);

	t.end();
});

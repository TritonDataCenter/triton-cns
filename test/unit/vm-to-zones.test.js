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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']), ['abc123.inst.def432']);
	t.deepEqual(Object.keys(zones['3.2.1.in-addr.arpa']), ['4']);

	var fwd = zones['foo']['abc123.inst.def432'];
	t.deepEqual(fwd, [
	    {constructor: 'A', args: ['1.2.3.4']},
	    {constructor: 'TXT', args: ['abc123']}
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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']), [
	    'abc123.inst.def432', 'cloudapi.svc.def432', 'cloudapi']);
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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']),
	    ['abc123.inst.def432', 'test.inst.def432']);
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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']),
	    ['abc123.inst.def432', 'abc123.inst.bar']);
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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']),
	    ['abc123.inst.def432', 'abc123.inst.bar', 'test.inst.def432',
	     'test.inst.bar']);
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
		'foo': {}
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
		    zones: ['foo']
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
		'foo': {},
		'bar': {}
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
		    zones: ['foo']
		},
		{
		    ip: '3.2.1.4',
		    zones: ['bar']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(),
	    ['1.2.3.in-addr.arpa', '3.2.1.in-addr.arpa', 'bar', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.inst.bar', 'abc123.inst.def432', 'test.inst.bar',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['bar']).sort(),
	    Object.keys(zones['foo']).sort());

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
		'foo': {},
		'bar': {},
		'baz': {}
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
		    zones: ['foo', 'bar']
		},
		{
		    ip: '3.2.1.4',
		    zones: ['baz']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones).sort(),
	    ['1.2.3.in-addr.arpa', '3.2.1.in-addr.arpa', 'bar', 'baz', 'foo']);

	t.deepEqual(Object.keys(zones['foo']).sort(),
	    ['abc123.inst.bar', 'abc123.inst.def432', 'test.inst.bar',
	    'test.inst.def432']);
	t.deepEqual(Object.keys(zones['bar']).sort(),
	    Object.keys(zones['foo']).sort());

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
		'foobarbaz': {},
		'foobar': {},
		'baz': {}
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
		    zones: ['foobar', 'foobarbaz', 'baz']
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
		'foo': {}
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
		    zones: ['foo']
		}
	    ]
	};
	var zones = buildZonesFromVm(vm, config, log);
	t.deepEqual(Object.keys(zones), ['foo', '3.2.1.in-addr.arpa']);

	t.deepEqual(Object.keys(zones['foo']),
	    ['abc123.inst.def432', 'test.inst.def432', 'svc1.svc.def432']);

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

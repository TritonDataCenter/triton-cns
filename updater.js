/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var redis = require('redis');
var bunyan = require('bunyan');
var UpdateStream = require('./lib/update-stream');
var FlagFilter = require('./lib/flag-filter');
var CNFilter = require('./lib/cn-filter');
var UfdsFilter = require('./lib/ufds-filter');
var NetFilter = require('./lib/net-filter');
var PollerStream = require('./lib/poller-stream');
var ReaperStream = require('./lib/reaper-stream');
var config = require('./lib/config');
var path = require('path');

var confPath;
if (process.argv[2])
    confPath = process.argv[2];
if (confPath === undefined)
    confPath = path.join(__dirname, 'etc', 'config.json');
var conf = config.parse(confPath);

var client = redis.createClient(conf.redis_opts);

var log = bunyan.createLogger({name: 'cns', level: 'trace'})

var ps = new PollerStream({log: log, config: conf});
var cnf = new CNFilter({log: log, config: conf});
var uf = new UfdsFilter({log: log, config: conf});
var nf = new NetFilter({log: log, config: conf});
var fs = new FlagFilter({log: log, config: conf});
var s = new UpdateStream({client: client, log: log});
ps.pipe(cnf);
cnf.pipe(uf);
uf.pipe(nf);
nf.pipe(fs);
fs.pipe(s);

s.openSerial(false);
ps.start();
ps.once('pollFinish', function () {
	log.info('first poll done, committing...');
	s.closeSerial();
    
    function poll() {
        ps.start();
        setTimeout(poll, 10000);
    }
    setTimeout(poll, 10000);

    var rs = new ReaperStream({log: log, config: conf, client: client});
    rs.pipe(cnf);
    function reap() {
        rs.start();
        setTimeout(reap, 300000);
    }
    setTimeout(reap, 15000);
});

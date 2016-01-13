/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = {
	probePeerVersion: probePeerVersion,
	getPeerSOA: getPeerSOA
};

var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var named = require('named');
var EventEmitter = require('events').EventEmitter;
var sprintf = util.format;
var vasync = require('vasync');
var ipaddr = require('ipaddr.js');
var dns = require('dns');
var crypto = require('crypto');
var dgram = require('dgram');
var net = require('net');

var consts = require('./consts');

var META_SUFFIX = '._cns_meta';
var TTL = 30;
var NS_TTL = 3600;
var VERSION = consts.VERSION;

var protocol = named.Protocol;

function probePeerVersion(peer, cb) {
	probePeerVersionGeneric(peer, function (generr, genver) {
		if (!generr && typeof (genver) === 'string') {
			cb(null, genver);
			return;
		}
		probePeerVersionBind(peer, function (binderr, bindver) {
			if (!binderr && typeof (bindver) === 'string') {
				if (/^9\./.test(bindver))
					bindver = 'ISC BIND ' + bindver;
				cb(null, bindver);
				return;
			}

			probePeerVersionCNS(peer, function (cnserr, cnsver) {
				if (!cnserr && typeof (cnsver) === 'string') {
					cb(null, 'Triton CNS ' + cnsver);
					return;
				}

				cb(cnserr);
			});
		});
	});
}

function probePeerVersionGeneric(peer, cb) {
	var question = {
	    name: 'version.server',
	    type: protocol.queryTypes.TXT,
	    qclass: protocol.qClasses.CH
	};
	sendUDPQuery(peer, question, function (err, reply) {
		if (err) {
			cb(err);
			return;
		}
		var ans = reply.answer[0];
		if (!ans || ans.rtype !== protocol.queryTypes.TXT) {
			var qerr = new Error('Empty answer received, or ' +
			    'answer of incorrect type');
			cb(qerr);
			return;
		}
		cb(null, ans.rdata.target);
	});
}

function probePeerVersionCNS(peer, cb) {
	var question = {
	    name: 'version._cns_meta',
	    type: protocol.queryTypes.TXT,
	    qclass: protocol.qClasses.IN
	};
	sendUDPQuery(peer, question, function (err, reply) {
		if (err) {
			cb(err);
			return;
		}
		var ans = reply.answer[0];
		if (!ans || ans.rtype !== protocol.queryTypes.TXT) {
			var qerr = new Error('Empty answer received, or ' +
			    'answer of incorrect type');
			cb(qerr);
			return;
		}
		cb(null, ans.rdata.target);
	});
}

function probePeerVersionBind(peer, cb) {
	var question = {
	    name: 'version.bind',
	    type: protocol.queryTypes.TXT,
	    qclass: protocol.qClasses.CH
	};
	sendUDPQuery(peer, question, function (err, reply) {
		if (err) {
			cb(err);
			return;
		}
		var ans = reply.answer[0];
		if (!ans || ans.rtype !== protocol.queryTypes.TXT) {
			var qerr = new Error('Empty answer received, or ' +
			    'answer of incorrect type');
			cb(qerr);
			return;
		}
		cb(null, ans.rdata.target);
	});
}

function getPeerSOA(peer, zone, cb) {
	var question = {
	    name: zone,
	    type: protocol.queryTypes.SOA,
	    qclass: protocol.qClasses.IN
	};
	sendUDPQuery(peer, question, function (err, reply) {
		if (err) {
			cb(err);
			return;
		}
		var ans = reply.answer[0];
		if (!ans || ans.rtype !== protocol.queryTypes.SOA) {
			var qerr = new Error('Empty answer received, or ' +
			    'answer of incorrect type');
			cb(qerr);
			return;
		}
		cb(null, ans.rdata);
	});
}

function sendUDPQuery(addr, question, cb) {
	var id = crypto.randomBytes(2).readUInt16BE(0);
	var packet = {};
	packet.header = {
	    id: id,
	    flags: {
		opcode: protocol.opCodes.QUERY,
		rcode: protocol.rCodes.NOERROR
	    },
	    qdCount: 1,
	    anCount: 0,
	    nsCount: 0,
	    arCount: 1
	};
	packet.question = [
	    question
	];
	packet.answer = [];
	packet.authority = [];
	packet.additional = [
	    {
		name: '.',
		rtype: protocol.queryTypes.OPT,
		rclass: 1200,
		rttl: 0,
		rdata: { options: [] }
	    }
	];

	var packetBuf = protocol.encode(packet, 'message');
	assert.buffer(packetBuf);

	var timer = setTimeout(onTimeout, 2000);

	var family = 'udp6';
	if (net.isIPv4(addr))
		family = 'udp4';
	var sock = dgram.createSocket(family);
	sock.once('error', function (err) {
		clearTimeout(timer);
		sock.close();
		cb(err);
	});
	sock.once('message', onMessage);
	sock.send(packetBuf, 0, packetBuf.length, 53, addr);

	function onMessage(msg) {
		clearTimeout(timer);
		var reply = protocol.decode(msg, 'message');
		if (reply.header.id !== id) {
			sock.once('message', onMessage);
			return;
		}
		sock.close();
		var rcode = reply.header.flags.rcode;
		if (rcode !== protocol.rCodes.NOERROR) {
			var code = protocol.rCodes[rcode];
			var err = new Error('DNS error: ' + code);
			err.rcode = rcode;
			err.code = code;
			cb(err);
			return;
		}
		cb(null, reply);
	}

	function onTimeout() {
		sock.close();
		cb(new Error('Request timed out'));
	}
}

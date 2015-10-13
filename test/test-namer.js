/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = makeTest;

var tape = require('tape');

function makeTest(basename) {
	return (function () {
		var args = Array.prototype.slice.call(arguments);
		var name = args.shift();
		name = basename + ': ' + name;
		args.unshift(name);
		return (tape.test.apply(this, args));
	});
}

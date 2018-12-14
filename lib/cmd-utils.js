/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var sprintf = require('sprintf-js').sprintf;
var vsprintf = require('sprintf-js').vsprintf;

function parseVal(schema, val) {
	switch (schema.type) {
	case 'string':
		return (val);
	case 'number':
		return (parseInt(val, 10));
	case 'array':
		if (schema.items.type === 'object')
			return (parseVal(schema.items, val));
		return (val.split(',').map(parseVal.bind(this, schema.items)));
	case 'object':
		try {
			return (JSON.parse(val));
		} catch (e) {
			console.error('cnsadm: invalid json value ' +
			    '"%s": %s', val, e.message);
			process.exit(1);
			return (undefined);
		}
	case 'boolean':
		switch (val) {
		case 'false':
		case 'no':
		case 'off':
			return (false);
		case 'true':
		case 'yes':
		case 'on':
			return (true);
		default:
			console.error('cnsadm: invalid boolean value "%s"',
			    val);
			process.exit(1);
			return (undefined);
		}
	default:
		throw (new Error('Unknown value type: ' + schema.type));
	}
}

/*JSSTYLED*/
var MODIFIER_RE = /^([a-z][a-z0-9_.-]*[a-z0-9])([+-]?=)(.+)$/;

function parseModifiers(args, oldObj, schema) {
	assert.strictEqual(schema.type, 'object');
	var changes = {};
	for (var i = 0; i < args.length; ++i) {
		var arg = args[i];
		var m = MODIFIER_RE.exec(arg);
		if (!m) {
			console.error('cnsadm: error parsing modifier ' +
			    'argument: %s', arg);
			process.exit(1);
		}

		var name = m[1];
		var op = m[2];
		var val = m[3];

		var valSchema = schema.properties[name];
		if (!valSchema) {
			console.error('cnsadm: unknown field %s', name);
			process.exit(1);
		}

		val = parseVal(valSchema, val);
		switch (op) {
		case '=':
			changes[name] = val;
			break;
		case '+=':
			if (valSchema.type !== 'array') {
				console.error('cnsadm: += operator can only ' +
				    'be used on array types, %s is not an ' +
				    'array', name);
				process.exit(1);
			}
			changes[name] = (oldObj[name] || []).concat(val);
			break;
		case '-=':
			if (valSchema.type !== 'array') {
				console.error('cnsadm: -= operator can only ' +
				    'be used on array types, %s is not an ' +
				    'array', name);
				process.exit(1);
			}
			changes[name] = [];
			var orig = (oldObj[name] || []);
			for (i = 0; i < orig.length; ++i) {
				var add = true;
				for (var j = 0; j < val.length; ++j) {
					if (jsprim.deepEquals(
					    orig[i], val[j])) {
						add = false;
						break;
					}
				}
				if (add)
					changes[name].push(orig[i]);
			}
			break;
		default:
			console.error('cnsadm: unknown operator %s used on ' +
			     'field %s', op, name);
			process.exit(1);
			break;
		}
	}
	return (changes);
}

function printFromSchema(obj, schema, waiting) {
	assert.strictEqual(schema.type, 'object');

	/* First pass: calculate the width of the name column and help. */
	var nameWidth, helpWidth;
	Object.keys(schema.properties).forEach(function (k) {
		if (nameWidth === undefined || k.length > nameWidth)
			nameWidth = k.length;

		var help = schema.properties[k].help;
		if (help &&
		    (helpWidth === undefined || help.length > helpWidth)) {
			helpWidth = help.length;
		}
	});

	/* Allow an extra char for the colon. */
	++nameWidth;
	/* And add some space at the end of the help text. */
	helpWidth += 4;

	var showHelp = false;
	var showStar = false;
	var cols = parseInt(process.env.COLUMNS || '80', 10);
	if (cols > nameWidth + helpWidth + 40)
		showHelp = true;

	var fmt = '%-' + nameWidth + 's  %s';

	if (showHelp) {
		var valWidth = (cols - (nameWidth + helpWidth + 6));
		fmt = '%-' + nameWidth + 's  %-' + valWidth + 's  %s';
	}

	/* Second pass: print out the entries. */
	Object.keys(schema.properties).forEach(function (k) {
		var prop = schema.properties[k];
		var help = prop.help ? ('(' + prop.help + ')') : '';

		var val = obj[k];
		if (prop.type === 'array') {
			val = (val || []).slice();
			var first = val.shift();
			if (first === undefined)
				first = '[]';
			if (typeof (prop.stringify) === 'function') {
				first = prop.stringify(first);
			} else if (prop.items.type === 'boolean') {
				first = first ? 'true' : 'false';
			} else {
				first = String(first);
			}
			if (waiting && waiting[k]) {
				first = first + '*';
				showStar = true;
			}
			console.log(sprintf(fmt, k + ':', first, help));
			val.forEach(function (v) {
				if (typeof (prop.stringify) === 'function') {
					v = prop.stringify(v);
				} else if (prop.items.type === 'boolean') {
					v = v ? 'true' : 'false';
				} else {
					v = String(v);
				}
				console.log(sprintf(fmt, '', v, ''));
			});
		} else {
			if (typeof (prop.stringify) === 'function') {
				val = prop.stringify(val);
			} else if (prop.type === 'boolean') {
				val = val ? 'true' : 'false';
			} else {
				val = String(val);
			}
			if (waiting && waiting[k]) {
				val = val + '*';
				showStar = true;
			}
			console.log(sprintf(fmt, k + ':', val, help));
		}
	});

	if (showStar) {
		console.log('* - changes waiting on config-agent to apply');
	}
}

function printTable(columns, objs) {
	var widths = [];
	var widest, widestIdx;
	for (var i = 0; i < columns.length; ++i) {
		var tlen = (columns[i].title || columns[i].field).length;
		if (widths[i] === undefined || tlen > widths[i])
			widths[i] = tlen;
		objs.forEach(function (obj) {
			var v = obj[columns[i].field];
			if (typeof (columns[i].stringify) === 'function')
				v = columns[i].stringify(v);
			else if (columns[i].type === 'boolean')
				v = v ? 'true' : 'false';
			else
				v = String(v);
			if (v.length > widths[i])
				widths[i] = v.length;
		});
		if (widest === undefined || widths[i] > widest) {
			widest = widths[i];
			widestIdx = i;
		}
	}

	var maxWidth = process.env.COLUMNS || 80;
	if (maxWidth > 80)
		maxWidth -= 2;
	if (maxWidth > 120)
		maxWidth = 120;

	var total = widths.reduce(function (w, acc) { return (w + acc); }, 0);
	total += 2 * (widths.length - 1);
	if (total > maxWidth) {
		var col = columns[widestIdx];
		widths[widestIdx] -= (total - maxWidth);
		var min = (col.title || col.field).length + 3;
		if (widths[widestIdx] < min)
			widths[widestIdx] = min;
	}

	var fmt = widths.
	    map(function (w) {return ('%-' + w + 's'); }).
	    join('  ');
	var headings = columns.map(function (c) {
		return ((c.title || c.field).toUpperCase());
	});
	console.log(vsprintf(fmt, headings));
	objs.forEach(function (obj) {
		var row = [];
		for (var j = 0; j < columns.length; ++j) {
			var v = obj[columns[j].field];
			if (typeof (columns[j].stringify) === 'function')
				v = columns[j].stringify(v);
			else if (columns[j].type === 'boolean')
				v = v ? 'true' : 'false';
			else
				v = String(v);
			if (v.length > widths[j])
				v = v.slice(0, widths[j] - 3) + '...';
			row.push(v);
		}
		console.log(vsprintf(fmt, row));
	});
}

function timeUnits(n) {
	var units = 'sec';
	while (true) {
		if (n >= 59.5) {
			n /= 60;
			units = 'min';
		} else {
			break;
		}
		if (n >= 59.5) {
			n /= 60;
			units = 'hr';
		} else {
			break;
		}
		if (n >= 23.5) {
			n /= 24;
			units = 'day';
		} else {
			break;
		}
		if (n >= 6.5) {
			n /= 7;
			units = 'wk';
		}
		break;
	}
	return (sprintf('%.0f %s%s', n, units,
	    Math.round(n) > 1 ? 's' : ''));
}

module.exports = {
	parseModifiers: parseModifiers,
	printFromSchema: printFromSchema,
	printTable: printTable,
	timeUnits: timeUnits
};

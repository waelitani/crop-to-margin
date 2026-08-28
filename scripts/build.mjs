#!/usr/bin/env node
/* Packs addon/ into build/crop-to-margin-<version>.xpi.
 *
 * An .xpi is a ZIP file, and Node ships everything a ZIP writer needs, so this
 * has no dependencies to install or audit.
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'addon');
const OUTPUT = join(ROOT, 'build');

const CRC_TABLE = (() => {
	let table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = -1;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function walk(dir) {
	let out = [];
	for (let name of readdirSync(dir).sort()) {
		let full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

/** DOS date/time, fixed so identical inputs produce byte-identical archives. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
	let locals = [];
	let central = [];
	let offset = 0;

	for (let { name, data } of entries) {
		let nameBuffer = Buffer.from(name, 'utf8');
		let compressed = deflateRawSync(data, { level: 9 });
		let stored = compressed.length < data.length;
		let payload = stored ? compressed : data;
		let method = stored ? 8 : 0;
		let sum = crc32(data);

		let local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuffer.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuffer, payload);

		let entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0, 8);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt16LE(DOS_TIME, 12);
		entry.writeUInt16LE(DOS_DATE, 14);
		entry.writeUInt32LE(sum, 16);
		entry.writeUInt32LE(payload.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBuffer.length, 28);
		entry.writeUInt16LE(0, 30);
		entry.writeUInt16LE(0, 32);
		entry.writeUInt16LE(0, 34);
		entry.writeUInt16LE(0, 36);
		entry.writeUInt32LE(0, 38);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBuffer);

		offset += local.length + nameBuffer.length + payload.length;
	}

	let directory = Buffer.concat(central);
	let end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

let manifest = JSON.parse(readFileSync(join(SOURCE, 'manifest.json'), 'utf8'));
let version = manifest.version;
let addonID = manifest.applications.zotero.id;

let entries = walk(SOURCE).map(path => ({
	name: relative(SOURCE, path).split(sep).join('/'),
	data: readFileSync(path)
}));

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });

let xpiName = `crop-to-margin-${version}.xpi`;
let archive = zip(entries);
writeFileSync(join(OUTPUT, xpiName), archive);

// The same bytes again under a name that never changes. Two assets on a release
// look redundant, and the redundancy is the point: update.json below pins the
// VERSIONED url plus a hash, so Zotero can never be handed a build its hash was
// not computed from, while `releases/latest/download/crop-to-margin.xpi` gives a
// human a link that survives every future release. One url cannot be both.
let stableName = 'crop-to-margin.xpi';
writeFileSync(join(OUTPUT, stableName), archive);

let hash = createHash('sha256').update(archive).digest('hex');
writeFileSync(join(ROOT, 'update.json'), JSON.stringify({
	addons: {
		[addonID]: {
			updates: [{
				version,
				update_link: `https://github.com/waelitani/crop-to-margin/releases/download/v${version}/${xpiName}`,
				update_hash: `sha256:${hash}`,
				applications: {
					zotero: {
						strict_min_version: manifest.applications.zotero.strict_min_version,
						strict_max_version: manifest.applications.zotero.strict_max_version
					}
				}
			}]
		}
	}
}, null, '\t') + '\n');

console.log(`${xpiName}  (+ ${stableName})  ${entries.length} files  ${(archive.length / 1024).toFixed(1)} KiB`);
console.log(`sha256:${hash}`);

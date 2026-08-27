/* Checks the plugin's measurement arithmetic without Zotero.
 *
 * The fixture holds the real per-page measurements taken from Davidson,
 * "Turbulence: An Introduction for Scientists and Engineers" (647 pages), plus
 * the crop that tools/analyze_margins.py derives from them. The plugin has to
 * agree with the reference implementation to the last decimal.
 *
 *     node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadPlugin(prefs = {}) {
	let source = readFileSync(join(ROOT, 'addon/content/crop-to-margin.js'), 'utf8');
	let context = createContext({
		Zotero: {
			debug() {},
			logError() {},
			Prefs: {
				get(name) {
					return prefs[name.replace('extensions.zotero.crop-to-margin.', '')];
				}
			}
		},
		Localization: class { formatValueSync() { return null; } },
		setTimeout,
		clearTimeout,
		WeakSet,
		WeakMap
	});
	runInContext(source + '\nCropToMargin;', context);
	return runInContext('CropToMargin', context);
}

const fixture = JSON.parse(
	readFileSync(join(ROOT, 'test/fixtures/davidson-turbulence.json'), 'utf8')
);

test('agrees with the reference implementation on a real textbook', () => {
	let plugin = loadPlugin();
	let crop = plugin.consensus(fixture.samples, fixture.pages);
	let expected = fixture.crop;

	assert.equal(crop.mirrored, expected.mirrored, 'mirrored margins detected');
	assert.equal(crop.clustered, expected.clustered, 'body layout isolated');
	assert.equal(crop.bodyPages, expected.body_pages);
	for (let parity of ['odd', 'even']) {
		for (let side of ['l', 'r', 't', 'b']) {
			assert.ok(
				Math.abs(crop[parity][side] - expected[parity][side]) < 1e-12,
				`${parity}.${side}: ${crop[parity][side]} != ${expected[parity][side]}`
			);
		}
	}
});

test('recto and verso end up the same width', () => {
	let plugin = loadPlugin();
	let crop = plugin.consensus(fixture.samples, fixture.pages);
	let odd = 1 - crop.odd.l - crop.odd.r;
	let even = 1 - crop.even.l - crop.even.r;
	assert.ok(Math.abs(odd - even) < 1e-12, `${odd} != ${even}`);
	assert.ok(odd > 0.7 && odd < 0.72, `expected ~71% of the page width, got ${odd}`);
});

test('mirrored margins can be turned off', () => {
	let plugin = loadPlugin({ mirrorMargins: false });
	let crop = plugin.consensus(fixture.samples, fixture.pages);
	assert.equal(crop.mirrored, false);
	assert.deepEqual(crop.odd, crop.even);
	// Without the recto/verso split the crop has to be the narrower, safe one.
	assert.ok(1 - crop.odd.l - crop.odd.r > 0.78);
});

test('never crops a page down to a sliver', () => {
	let plugin = loadPlugin({ maxCrop: 45, padding: 0 });
	let absurd = Array.from({ length: 12 }, (unused, i) => ({
		index: i, pageWidth: 600, pageHeight: 800, area: 0.05,
		l: 0.48, r: 0.48, t: 0.48, b: 0.48
	}));
	let crop = plugin.consensus(absurd, 12);
	assert.ok(1 - crop.odd.l - crop.odd.r >= 0.4 - 1e-12);
	assert.ok(1 - crop.odd.t - crop.odd.b >= 0.4 - 1e-12);
});

test('a document with no margins is left alone', () => {
	let plugin = loadPlugin();
	let fullBleed = Array.from({ length: 12 }, (unused, i) => ({
		index: i, pageWidth: 600, pageHeight: 800, area: 1,
		l: 0, r: 0, t: 0, b: 0
	}));
	let crop = plugin.consensus(fullBleed, 12);
	// Nothing to take off any side, so the page is left exactly as it is.
	for (let parity of ['odd', 'even']) {
		for (let side of ['l', 'r', 't', 'b']) {
			assert.equal(crop[parity][side], 0, `${parity}.${side}`);
		}
	}
	assert.equal(crop.mirrored, false);
});

test('samples alternate recto and verso', () => {
	let plugin = loadPlugin();
	// An even stride would otherwise stay on one side of the book for the whole
	// document, hiding mirrored margins completely.
	for (let pages of [647, 200, 101, 64, 33]) {
		let picked = plugin.pickPages(pages, 16);
		let odd = picked.filter(i => (i + 1) % 2 === 1).length;
		assert.ok(odd >= 3 && picked.length - odd >= 3,
			`${pages} pages: ${odd} recto, ${picked.length - odd} verso`);
		assert.ok(picked.every(i => i >= 0 && i < pages));
	}
});

test('the crop rotates with the page', () => {
	let plugin = loadPlugin();
	let side = { l: 0.2, r: 0.1, t: 0.05, b: 0.08 };
	let pageView = (rotation) => ({
		id: 1,
		viewport: { rotation, rawDims: { pageWidth: 500, pageHeight: 800 } }
	});
	let upright = plugin.displayCrop(pageView(0), side);
	assert.deepEqual(
		[upright.l, upright.r, upright.t, upright.b, upright.width, upright.height],
		[100, 50, 40, 64, 500, 800]
	);
	// Turned a quarter clockwise, the left margin becomes the top one.
	let turned = plugin.displayCrop(pageView(90), side);
	assert.deepEqual(
		[turned.t, turned.r, turned.b, turned.l, turned.width, turned.height],
		[100, 40, 50, 64, 800, 500]
	);
	// Whatever the rotation, the same amount of paper is removed.
	for (let rotation of [0, 90, 180, 270]) {
		let box = plugin.displayCrop(pageView(rotation), side);
		assert.ok(Math.abs((box.l + box.r + box.t + box.b) - 254) < 1e-9);
	}
});

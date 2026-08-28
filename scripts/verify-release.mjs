/*
 * Verify that what update.json advertises can actually be downloaded.
 *
 * The drift check in CI proves update.json matches the bytes this build just
 * produced. It cannot prove those bytes were ever published: push main without
 * its tag and update.json truthfully describes an .xpi that exists nowhere, so
 * every install polls, is offered the new version, and fails to fetch it. That
 * happened once, and nothing in the pipeline noticed — the build was green.
 *
 * Retries because a 404 straight after a release is meaningless. GitHub's asset
 * CDN lags its own API: an asset the API already reports as `state: uploaded`
 * can 404 for the better part of a minute, and its identically-sized twin in
 * the same release can serve fine while it does. Only a 404 that outlives the
 * whole window says something real.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ATTEMPTS = Number(process.env.VERIFY_ATTEMPTS || 20);
const INTERVAL_MS = Number(process.env.VERIFY_INTERVAL_MS || 15000);

let manifest = JSON.parse(readFileSync(join(ROOT, 'addon/manifest.json'), 'utf8'));
let addonID = manifest.applications.zotero.id;
let update = JSON.parse(readFileSync(join(ROOT, 'update.json'), 'utf8'));

let entry = update.addons?.[addonID]?.updates?.[0];
if (!entry) {
	fail(`update.json has no entry for ${addonID}`);
}

// Free, instant, and catches a whole class of hand-edit: the two files
// disagreeing about which version is current.
if (entry.version !== manifest.version) {
	fail(`update.json advertises ${entry.version} but the manifest says ${manifest.version}`);
}

let want = (entry.update_hash || '').replace(/^sha256:/, '');
if (!want) fail('update.json carries no sha256 update_hash');

console.log(`advertising ${entry.version}`);
console.log(`  ${entry.update_link}`);

let body = await fetchWithRetry(entry.update_link);
let got = createHash('sha256').update(body).digest('hex');

if (got !== want) {
	fail(`the published .xpi is not the one update.json describes\n`
		+ `  expected sha256:${want}\n`
		+ `  received sha256:${got}`);
}
console.log(`  ${body.length} bytes, sha256 matches`);

// The link the README hands a human. A release that never got the stable-named
// copy attached would leave that one url pointing at nothing.
let latest = entry.update_link.replace(/\/download\/[^/]+\/.*$/, '/latest/download/crop-to-margin.xpi');
let stable = await fetchWithRetry(latest);
console.log(`  latest/download/crop-to-margin.xpi resolves, ${stable.length} bytes`);

console.log('auto-update chain is intact');

async function fetchWithRetry(url) {
	let last = '';
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		let response;
		try {
			response = await fetch(url, { redirect: 'follow' });
		}
		catch (e) {
			last = e.message;
			response = null;
		}
		if (response && response.ok) {
			return Buffer.from(await response.arrayBuffer());
		}
		if (response) last = `HTTP ${response.status}`;
		if (attempt === ATTEMPTS) break;
		console.log(`  ${last}, retrying (${attempt}/${ATTEMPTS - 1})`);
		await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
	}
	fail(`${url}\n  never became downloadable: ${last}\n`
		+ `  waited ${((ATTEMPTS - 1) * INTERVAL_MS) / 1000}s. If the tag was never pushed, push it:\n`
		+ `      git push origin v${manifest.version}`);
}

function fail(message) {
	console.error(`\nupdate.json advertises something that is not there.\n${message}\n`);
	process.exit(1);
}

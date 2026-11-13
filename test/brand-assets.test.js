'use strict';

// The Oxyx brand assets are generated from one grid (scripts/build-brand.js)
// and every reference points at a file that exists.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./helpers/app');
const { tileSvg, MARK, LETTERS } = require('../scripts/build-brand');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the grids are well formed', () => {
  assert.equal(MARK.length, 16);
  assert.ok(MARK.every((r) => r.length === 16 && /^[.#]+$/.test(r)));
  for (const [ch, rows] of Object.entries(LETTERS)) {
    assert.ok(rows.length === 8 && rows.every((r) => r.length === 8), ch);
  }
});

test('the committed favicon is what the generator produces (no hand edits drift)', () => {
  assert.equal(read('public/favicon.svg').trim(), tileSvg());
});

test('every icon the manifest, service worker, head and offline page name exists', () => {
  const manifest = JSON.parse(read('public/manifest.json'));
  const refs = new Set([
    ...manifest.icons.map((i) => i.src),
    ...manifest.shortcuts.flatMap((s) => s.icons.map((i) => i.src)),
    ...[...read('public/sw.js').matchAll(/'(\/[^']+\.(?:png|svg))'/g)].map((m) => m[1]),
    ...[...read('views/partials/app-head.hbs').matchAll(/href="(\/[^"]+\.(?:png|svg))"/g)].map((m) => m[1]),
    ...[...read('public/offline.html').matchAll(/src="(\/[^"]+\.png)"/g)].map((m) => m[1]),
    ...[...read('public/js/lib/pwa.js').matchAll(/'(\/icons\/[^']+\.png)'/g)].map((m) => m[1]),
  ]);
  assert.ok(refs.size >= 6);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(root, 'public', ref)), ref);
  assert.ok(![...refs].some((r) => r.includes('pickaxe')), 'no old pickaxe brand icons remain');
});

test('the sign-in page shows the Oxyx mark and wordmark', async (t) => {
  await app.start();
  t.after(() => app.stop());
  const page = await app.req('GET', '/setup', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /<span class="pixel[^"]*">OXYX<\/span>/);
  assert.ok(page.text.includes('shape-rendering="crispEdges" aria-hidden="true"'), 'inline brand mark');
  assert.doesNotMatch(page.text, /Server Manager/);
});

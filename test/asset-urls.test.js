'use strict';

// Hashed client bundles and versioned CSS can be cached for a year (F-18).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const app = require('./helpers/app');
const { makeAssetResolver } = require('../src/web/app');

test('asset maps JS through the manifest and versions CSS by content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-'));
  fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });
  const css = path.join(root, 'public', 'css', 'app.css');
  fs.writeFileSync(css, 'a{}');
  const asset = makeAssetResolver({ root, manifest: { 'pages/map.js': 'pages/map-AB12CD34.js' } });
  assert.equal(asset('/js/pages/map.js'), '/js/pages/map-AB12CD34.js');
  assert.equal(asset('/js/pages/unknown.js'), '/js/pages/unknown.js');
  const v1 = asset('/css/app.css');
  assert.match(v1, /^\/css\/app\.css\?v=[0-9a-f]{12}$/);
  fs.writeFileSync(css, 'b{}');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(css, later, later);
  assert.notEqual(asset('/css/app.css'), v1, 'a rebuilt stylesheet gets a new URL');
  // No bundle (dev): raw source paths.
  assert.equal(makeAssetResolver({ root, manifest: null })('/js/app.js'), '/js/app.js');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pages reference assets through the helper, and cache headers follow the URL', async (t) => {
  await app.start();
  t.after(() => app.stop());
  const cookie = await app.adminCookie();
  const page = await app.req('GET', '/', { cookie, headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  const cssUrl = /href="(\/css\/app\.css\?v=[0-9a-f]{12})"/.exec(page.text);
  assert.ok(cssUrl, 'stylesheet carries a content version');
  const css = await app.req('GET', cssUrl[1]);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const plain = await app.req('GET', '/css/app.css');
  assert.equal(plain.headers.get('cache-control'), 'no-cache');

  const appJs = /src="(\/js\/app[^"]*\.js)"/.exec(page.text)[1];
  const js = await app.req('GET', appJs);
  assert.equal(js.status, 200);
  if (/-[A-Z0-9]{8}\.js$/.test(appJs)) {
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  } else {
    assert.equal(js.headers.get('cache-control'), 'no-cache', 'raw source (no fresh build) revalidates');
  }
});

'use strict';

// public/js/lib/api.js: JSON in and out, a timeout, one sign-in redirect on
// 401, and an Error whose message is always safe to show (F-11).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let api;
let calls;
let respond;
let assigned;

test.before(async () => {
  // The client modules are ESM in a CommonJS package: load copies from a
  // folder marked as a module so their relative import resolves.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-api-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['api.js', 'errors.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'lib', f), path.join(dir, f));
  }
  globalThis.location = {
    pathname: '/servers/x',
    search: '?tab=map',
    assign: (u) => (assigned = u),
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  ({ api } = await import(pathToFileURL(path.join(dir, 'api.js')).href));
});

test.beforeEach(() => {
  calls = [];
  assigned = null;
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('sends JSON and returns the parsed body', async () => {
  respond = () => json(200, { ok: true, n: 1 });
  assert.deepEqual(await api('/api/x', { method: 'POST', body: { a: 1 } }), { ok: true, n: 1 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'always carries a timeout signal');
});

test('a server error message wins; without one the friendly fallback names the action', async () => {
  respond = () => json(409, { ok: false, error: 'Stop the server first.', code: 'running' });
  await assert.rejects(api('/api/x'), { message: 'Stop the server first.', status: 409, code: 'running' });
  respond = () => new Response('<html>', { status: 502 });
  await assert.rejects(api('/api/x', { action: 'save it' }), { message: /^Couldn't save it: the panel hit an error/ });
});

test('a network failure or timeout becomes a friendly Error, not a raw TypeError', async () => {
  respond = () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(api('/api/x', { action: 'load it' }), {
    message: /^Couldn't load it: the panel is unreachable/,
  });
  respond = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(api('/api/x', { timeoutMs: 20 }), { message: /unreachable/ });
});

test('401 sends the browser to sign-in once, coming back to this page', async () => {
  respond = () => json(401, { ok: false, error: 'Sign in again.' });
  await assert.rejects(api('/api/x'), { status: 401 });
  assert.equal(assigned, '/login?next=%2Fservers%2Fx%3Ftab%3Dmap');
  assigned = null;
  await assert.rejects(api('/api/y'), { status: 401 });
  assert.equal(assigned, null, 'no second redirect');
});

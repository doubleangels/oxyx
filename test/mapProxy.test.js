'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('./helpers/app');
const db = require('../src/db');
const { mintMapToken } = require('../src/web/routes/mapProxy');

let cookie;
let adminId;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  adminId = db.get("SELECT id FROM users WHERE username = 'admin'").id;
});

/** The tokenized map URL the Map tab would render for the admin. */
const mapUrl = (id, sub = '') => `/map/${id}/t/${mintMapToken(id, adminId)}/${sub}`;

test.after(async () => {
  await app.stop();
});

/** Enable "BlueMap" on a seeded server, pointed at a given host port. */
function enableMap(serverId, hostPort) {
  db.run(
    "INSERT INTO integrations (server_id, kind, enabled, config_json) VALUES (?, 'bluemap', 1, ?)",
    serverId,
    JSON.stringify({ hostPort })
  );
}

function listenOnFreePort(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('GET /map/:id/t/:token/ 404s when the map is not enabled', async () => {
  const id = app.seedServer('srv_map01');
  const r = await app.req('GET', mapUrl(id));
  assert.equal(r.status, 404);
});

test('GET /map/:id/t/:token/ 404s for an unknown server', async () => {
  const r = await app.req('GET', mapUrl('nope'));
  assert.equal(r.status, 404);
});

test('GET /map/:id/t/:token/ proxies through to the upstream BlueMap server (host-port fallback - no Docker in this test env)', async () => {
  const id = app.seedServer('srv_map02');
  const upstream = await listenOnFreePort((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Bluemap': 'yes' });
    res.end('hello from bluemap');
  });
  enableMap(id, upstream.address().port);
  try {
    const r = await app.req('GET', mapUrl(id));
    assert.equal(r.status, 200);
    assert.equal(r.text, 'hello from bluemap');
  } finally {
    upstream.close();
  }
});

test('GET /map/:id/t/:token/ returns 502 (not a hang) when nothing is listening on the configured port', async () => {
  const id = app.seedServer('srv_map03');
  const srv = await listenOnFreePort(() => {});
  const deadPort = srv.address().port;
  await new Promise((resolve) => srv.close(resolve)); // free the port, guaranteed nothing listens there
  enableMap(id, deadPort);

  const r = await app.req('GET', mapUrl(id));
  assert.equal(r.status, 502);
  assert.match(r.text, /not responding/);
});

test('a working target is cached - a second request does not re-probe (same upstream serves it again)', async () => {
  const id = app.seedServer('srv_map04');
  let hits = 0;
  const upstream = await listenOnFreePort((req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end('ok');
  });
  enableMap(id, upstream.address().port);
  try {
    const first = await app.req('GET', mapUrl(id));
    const second = await app.req('GET', mapUrl(id));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(hits, 2); // both requests reached the SAME upstream, proving the cached target was reused
  } finally {
    upstream.close();
  }
});

test('a proxied HTML response carries the sandbox CSP and open CORS, not the panel CSP (F-01)', async () => {
  const id = app.seedServer('srv_map05');
  const upstream = await listenOnFreePort((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': 'script-src *',
      'Set-Cookie': 'evil=1',
    });
    res.end('<script>fetch("/api/users")</script>');
  });
  enableMap(id, upstream.address().port);
  try {
    const r = await app.req('GET', mapUrl(id));
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /^sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /nonce-/, 'the panel CSP is replaced, not merged');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.setCookie.length, 0, 'no upstream or session cookie is set');
  } finally {
    upstream.close();
  }
});

test('a valid session without a token is refused (F-01)', async () => {
  const id = app.seedServer('srv_map06');
  const upstream = await listenOnFreePort((req, res) => res.end('map'));
  enableMap(id, upstream.address().port);
  try {
    assert.equal((await app.req('GET', `/map/${id}/`, { cookie })).status, 404);
    assert.equal((await app.req('GET', `/map/${id}/assets/app.js`, { cookie })).status, 404);
    assert.equal((await app.req('GET', `/map/${id}/t/garbage/`, { cookie })).status, 404);
    // Tampered signature.
    const token = mintMapToken(id, adminId);
    assert.equal((await app.req('GET', `/map/${id}/t/${token.slice(0, -2)}xx/`, { cookie })).status, 404);
  } finally {
    upstream.close();
  }
});

test('a token for server A is refused for server B, and an expired token is refused (F-01)', async () => {
  const a = app.seedServer('srv_map07');
  const b = app.seedServer('srv_map08');
  const upstream = await listenOnFreePort((req, res) => res.end('map'));
  enableMap(a, upstream.address().port);
  enableMap(b, upstream.address().port);
  try {
    assert.equal((await app.req('GET', mapUrl(a))).status, 200);
    const tokenA = mintMapToken(a, adminId);
    assert.equal((await app.req('GET', `/map/${b}/t/${tokenA}/`)).status, 404);
    const stale = mintMapToken(a, adminId, Date.now() - 7 * 3600 * 1000);
    assert.equal((await app.req('GET', `/map/${a}/t/${stale}/`)).status, 404);
    const ghost = mintMapToken(a, 'usr_gone');
    assert.equal((await app.req('GET', `/map/${a}/t/${ghost}/`)).status, 404, 'a deleted user loses access');
  } finally {
    upstream.close();
  }
});

test('the token root without a trailing slash redirects so relative assets resolve', async () => {
  const id = app.seedServer('srv_map09');
  const upstream = await listenOnFreePort((req, res) => res.end('map'));
  enableMap(id, upstream.address().port);
  try {
    const url = mapUrl(id).slice(0, -1);
    const r = await app.req('GET', url);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), `${url}/`);
  } finally {
    upstream.close();
  }
});

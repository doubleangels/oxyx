'use strict';

// DNS rebinding guard on the Host header (F-12).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('./helpers/app');
const config = require('../src/config');
const { hostName, hostAllowed, _resetForTests } = require('../src/web/middleware/hostGuard');

let base;
test.before(async () => {
  base = new URL(await app.start());
});
test.after(() => app.stop());

function raw(method, path, host, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        method,
        path,
        headers: {
          Host: host,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('hostName strips ports and IPv6 brackets', () => {
  assert.equal(hostName('Example.COM:25564'), 'example.com');
  assert.equal(hostName('[::1]:25564'), '::1');
  assert.equal(hostName('127.0.0.1'), '127.0.0.1');
});

test('first run: POST /setup with Host evil.example is refused with 421, and no admin is created', async () => {
  const r = await raw('POST', '/setup', 'evil.example', { username: 'evil', password: 'supersecret123' });
  assert.equal(r.status, 421);
  assert.match(r.text, /PANEL_ALLOWED_HOSTS/);
  assert.equal(require('../src/services/auth').firstRunNeeded(), true);
  // Loopback names and IP literals still work.
  assert.notEqual((await raw('GET', '/setup', `localhost:${base.port}`)).status, 421);
  assert.notEqual((await raw('GET', '/setup', `192.168.1.20:${base.port}`)).status, 421);
  assert.notEqual((await raw('GET', '/setup', `[::1]:${base.port}`)).status, 421);
});

test('a listed host passes during first run, and * turns the check off', () => {
  const saved = config.allowedHosts;
  try {
    config.allowedHosts = ['panel.example.com'];
    assert.equal(hostAllowed({ headers: { host: 'panel.example.com:443' } }), true);
    assert.equal(hostAllowed({ headers: { host: 'evil.example' } }), false);
    config.allowedHosts = ['*'];
    assert.equal(hostAllowed({ headers: { host: 'evil.example' } }), true);
  } finally {
    config.allowedHosts = saved;
  }
});

test('after setup an unlisted host passes unless PANEL_ALLOWED_HOSTS is set', async () => {
  await app.adminCookie();
  _resetForTests();
  assert.notEqual(
    (await raw('GET', '/login', 'proxy.example')).status,
    421,
    'existing reverse-proxy installs keep working'
  );
  const saved = config.allowedHosts;
  try {
    config.allowedHosts = ['panel.example.com'];
    assert.equal((await raw('GET', '/login', 'proxy.example')).status, 421);
    assert.notEqual((await raw('GET', '/login', 'panel.example.com')).status, 421);
  } finally {
    config.allowedHosts = saved;
  }
});

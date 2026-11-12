'use strict';

// Web Push: subscriptions are per device and per user, endpoints are limited to
// real push services on public addresses, choices filter what is sent, and a
// push service saying "gone" removes the device.

require('./helpers/env');
const urlGuard = require('../src/utils/urlGuard');
// No DNS in tests: treat the push-service hosts as public, and capture sends.
urlGuard.assertPublicUrl = async (u) => new URL(u);
const sent = [];
let nextStatus = 201;
urlGuard.safeFetch = async (url, opts) => {
  sent.push({ url, opts });
  return { status: nextStatus, ok: nextStatus < 300, headers: { get: () => null }, body: null };
};

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('./helpers/app');
const db = require('../src/db');
const push = require('../src/services/push');

function fakeSubscription(host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${crypto.randomBytes(8).toString('hex')}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

let cookie;
let adminId;
test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  adminId = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  app.seedServer('srv_push_a');
  app.seedServer('srv_push_b');
});
test.after(() => app.stop());

test('prefs are validated: unknown categories and bad times are dropped', () => {
  const p = push.normalizePrefs({
    categories: { crashes: false, nonsense: true },
    servers: ['srv_ok', '../x', 5],
    quiet: { enabled: true, from: '25:00', to: '06:30' },
  });
  assert.equal(p.categories.crashes, false);
  assert.equal('nonsense' in p.categories, false);
  assert.deepEqual(p.servers, ['srv_ok']);
  assert.equal(p.quiet.from, '22:00', 'invalid time keeps the default');
  assert.equal(p.quiet.to, '06:30');
});

test('quiet hours handle windows that wrap past midnight', () => {
  const q = { enabled: true, from: '22:00', to: '07:00' };
  assert.equal(push.inQuietHours(q, '23:30'), true);
  assert.equal(push.inQuietHours(q, '03:00'), true);
  assert.equal(push.inQuietHours(q, '07:00'), false);
  assert.equal(push.inQuietHours(q, '12:00'), false);
  assert.equal(push.inQuietHours({ enabled: true, from: '13:00', to: '14:00' }, '13:30'), true);
  assert.equal(push.inQuietHours({ ...q, enabled: false }, '23:30'), false);
});

test('only HTTPS endpoints on known push services are accepted (no internal hosts)', async () => {
  for (const bad of [
    'http://fcm.googleapis.com/x',
    'https://10.0.0.5:8443/push',
    'https://localhost/push',
    'https://evil.example/fcm.googleapis.com',
    'not a url',
  ]) {
    await assert.rejects(push.assertPushEndpoint(bad), { status: 400 }, bad);
  }
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ]) {
    await push.assertPushEndpoint(ok);
  }
  const r = await app.req('POST', '/api/account/push/subscribe', {
    cookie,
    body: { subscription: { ...fakeSubscription(), endpoint: 'https://169.254.169.254/latest' } },
  });
  assert.equal(r.status, 400);
});

test('a device subscribes, saves choices, sends a test, and is removed; nobody else can touch it', async () => {
  const cfg = await app.req('GET', '/api/account/push', { cookie });
  assert.equal(cfg.status, 200);
  assert.match(cfg.json.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.ok(cfg.json.categories.some((c) => c.key === 'crashes' && c.critical));

  const sub = fakeSubscription();
  const created = await app.req('POST', '/api/account/push/subscribe', {
    cookie,
    body: { subscription: sub, deviceName: 'Pixel', prefs: { categories: { lifecycle: true } } },
  });
  assert.equal(created.status, 201);
  const id = created.json.device.id;
  assert.equal(created.json.device.prefs.categories.lifecycle, true);
  const stored = db.get('SELECT auth_cipher FROM push_subscriptions WHERE id = ?', id);
  assert.ok(!stored.auth_cipher.includes(sub.keys.auth), 'auth secret is encrypted at rest');

  const mine = await app.req('GET', `/api/account/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { cookie });
  assert.equal(mine.json.thisDevice.id, id);

  const patched = await app.req('PATCH', `/api/account/push/devices/${id}`, {
    cookie,
    body: { deviceName: 'My Phone', prefs: { servers: ['srv_push_a'], quiet: { enabled: true } } },
  });
  assert.equal(patched.json.device.deviceName, 'My Phone');
  assert.deepEqual(patched.json.device.prefs.servers, ['srv_push_a']);

  sent.length = 0;
  const t = await app.req('POST', `/api/account/push/devices/${id}/test`, { cookie });
  assert.equal(t.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, sub.endpoint);
  assert.equal(sent[0].opts.method, 'POST');
  assert.equal(sent[0].opts.maxRedirects, 0, 'no redirects to anywhere else');
  assert.equal(sent[0].opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(sent[0].opts.headers.Authorization, /^vapid t=.+, k=/);

  // Another user cannot see, change or remove it.
  const auth = require('../src/services/auth');
  await auth.createUser({ username: 'pushviewer', password: 'viewerpass123', role: 'viewer' }, { actor: 'test' });
  const login = await app.req('POST', '/login', { body: { username: 'pushviewer', password: 'viewerpass123' } });
  const other = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  assert.equal((await app.req('GET', '/api/account/push', { cookie: other })).json.devices.length, 0);
  assert.equal(
    (await app.req('PATCH', `/api/account/push/devices/${id}`, { cookie: other, body: { deviceName: 'x' } })).status,
    404
  );
  assert.equal((await app.req('DELETE', `/api/account/push/devices/${id}`, { cookie: other })).status, 404);

  assert.equal((await app.req('DELETE', `/api/account/push/devices/${id}`, { cookie })).status, 200);
  assert.equal(db.get('SELECT 1 AS x FROM push_subscriptions WHERE id = ?', id), undefined);
});

test('the bridge sends each event only to devices that want it and may see the server', async () => {
  db.run('DELETE FROM push_subscriptions');
  const crashOnly = await push.subscribe(adminId, { subscription: fakeSubscription(), deviceName: 'A' });
  const onlyB = await push.subscribe(adminId, {
    subscription: fakeSubscription(),
    deviceName: 'B',
    prefs: { servers: ['srv_push_b'], categories: { lifecycle: true, joins: true } },
  });
  const original = push.deliver;
  const calls = [];
  push.deliver = async (row, payload) => {
    calls.push([row.id, payload]);
    return 'sent';
  };
  try {
    push._resetMarks();
    const { recordEvent } = require('../src/events');
    recordEvent({ serverId: 'srv_push_a', type: 'crashed', summary: 'Server crashed (exit code 1).' });
    recordEvent({ serverId: 'srv_push_b', type: 'started', summary: 'Server started.' });
    recordEvent({ serverId: 'srv_push_a', type: 'config-changed', summary: 'Configuration changed.' });
    db.run(
      "INSERT INTO player_events (server_id, ts, type, player) VALUES ('srv_push_b', ?, 'join', 'Steve')",
      new Date().toISOString()
    );
    await push.pollOnce({ now: '12:00' });
    const to = (id) => calls.filter(([d]) => d === id).map(([, p]) => p.title);
    assert.deepEqual(to(crashOnly.id), ['Test Server: Server Crashed'], 'default choices: crashes, not starts');
    assert.deepEqual(to(onlyB.id).sort(), ['Test Server: Player Joined', 'Test Server: Server Started']);
    const crash = calls.find(([, p]) => p.title.endsWith('Server Crashed'))[1];
    assert.equal(crash.critical, true);
    assert.equal(crash.url, '/servers/srv_push_a/history');

    // Quiet hours hold back a start but let a crash through.
    calls.length = 0;
    push.updateDevice(adminId, onlyB.id, {
      prefs: { servers: 'all', quiet: { enabled: true, from: '22:00', to: '07:00' } },
    });
    recordEvent({ serverId: 'srv_push_a', type: 'started', summary: 'Server started.' });
    recordEvent({ serverId: 'srv_push_a', type: 'oom', summary: 'Stopped for running out of memory.' });
    await push.pollOnce({ now: '23:15' });
    assert.deepEqual(to(onlyB.id), ['Test Server: Out of Memory']);
  } finally {
    push.deliver = original;
  }
});

test('a push service answering 410 removes the device', async () => {
  db.run('DELETE FROM push_subscriptions');
  const d = await push.subscribe(adminId, { subscription: fakeSubscription(), deviceName: 'Old' });
  nextStatus = 410;
  try {
    await assert.rejects(
      app.req('POST', `/api/account/push/devices/${d.id}/test`, { cookie }).then((r) => {
        if (r.status !== 200) throw Object.assign(new Error('gone'), { status: r.status });
      }),
      { status: 410 }
    );
  } finally {
    nextStatus = 201;
  }
  assert.equal(db.get('SELECT 1 AS x FROM push_subscriptions WHERE id = ?', d.id), undefined);
});

test('the Mobile App page and the share target render for any signed-in user', async () => {
  const html = { cookie, headers: { Accept: 'text/html' } };
  const page = await app.req('GET', '/settings/app', html);
  assert.equal(page.status, 200);
  assert.match(page.text, /Push Notifications/);
  const share = await app.req(
    'GET',
    `/share?text=${encodeURIComponent('look at https://modrinth.com/mod/sodium nice')}`,
    html
  );
  assert.equal(share.status, 200);
  assert.match(share.text, /\/servers\/srv_push_a\/mods\?addUrl(=|&#x3D;)https%3A%2F%2Fmodrinth\.com%2Fmod%2Fsodium/);
  const none = await app.req('GET', '/share?text=hello', html);
  assert.match(none.text, /No Link Found/);
  const manifest = JSON.parse(
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.share_target.action, '/share');
  assert.equal(manifest.start_url, '/?launch=app');
  assert.equal(manifest.id, '/', 'the app identity stays the same');
});

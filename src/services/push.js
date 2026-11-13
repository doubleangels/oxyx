'use strict';

// Web Push to installed panels on phones and desktops. Each device a user turns
// notifications on for is one push_subscriptions row with its own choices:
// which kinds of events, which servers, and quiet hours. A bridge polls the
// history log (and player joins) like the Discord bridge does, and sends each
// new event to every device that wants it and whose user may view the server.
//
// Delivery goes through safeFetch (public addresses only, no redirects) and
// only to the push services browsers actually use, so a registered endpoint can
// never make the panel call an internal host. VAPID keys are generated on first
// use and kept in the settings table, the private key encrypted at rest.

const path = require('node:path');
const { nanoid } = require('nanoid');
const db = require('../db');
const httpError = require('../utils/httpError');
const secrets = require('./secrets');
const settings = require('./settings');
const permissions = require('./permissions');
const { safeJsonParse } = require('../utils/safeJson');
const { safeFetch, assertPublicUrl } = require('../utils/urlGuard');
const logger = require('../logger')(path.basename(__filename));
const { makeFailureThrottle } = require('../logger');
const { serializeError } = require('../utils/logSanitize');

/** @type {any} */
let webpush = null;
function lib() {
  if (!webpush) webpush = require('web-push');
  return webpush;
}

// What a device can choose to hear about. `critical` kinds may break quiet hours.
const CATEGORIES = [
  {
    key: 'crashes',
    label: 'Crashes',
    help: 'A server crashed, keeps crashing, or wrote a crash report.',
    default: true,
    critical: true,
  },
  {
    key: 'alerts',
    label: 'Problems',
    help: 'Out of memory, a stalled startup, a failed scheduled task, a full disk quota, or a server that stopped responding.',
    default: true,
    critical: true,
  },
  { key: 'updates', label: 'Updates', help: 'An update was applied, rolled back, or failed.', default: true },
  { key: 'lifecycle', label: 'Start and Stop', help: 'A server started or stopped.', default: false },
  { key: 'backups', label: 'Backups', help: 'A backup was made or restored.', default: false },
  { key: 'players', label: 'Moderation', help: 'A player was banned or kicked.', default: false },
  { key: 'joins', label: 'Player Joins', help: 'Someone joined a server.', default: false },
];
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
const CRITICAL = new Set(CATEGORIES.filter((c) => c.critical).map((c) => c.key));

// Push services browsers use: FCM (Chrome, Edge on Android, Samsung Internet,
// Opera), Mozilla autopush (Firefox), Apple (Safari on iOS and macOS), WNS
// (Edge on Windows). A subscription for any other host is refused.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

const VAPID_KEY = 'push_vapid';
const MARK_KEY = 'push_bridge_last_event_id';
const JOIN_MARK_KEY = 'push_bridge_last_join_id';
const REPLAY_WINDOW_MINUTES = 30;
const MAX_FAILURES = 10;
const MAX_DEVICES_PER_USER = 20;
// VAPID needs a contact: a mailto: or https: URL identifying the sender.
const VAPID_SUBJECT = process.env.PUSH_CONTACT || 'https://github.com/doubleangels/oxyx';

/** The panel's VAPID key pair, created the first time it is needed. */
function vapidKeys() {
  const stored = settings.get(VAPID_KEY, null);
  if (stored && stored.publicKey && stored.privateKeyCipher) {
    const privateKey = secrets.tryDecrypt(stored.privateKeyCipher);
    if (privateKey) return { publicKey: stored.publicKey, privateKey };
    logger.warn(
      'The stored push key could not be decrypted, so a new one was made. Devices need to turn push on again.'
    );
  }
  const keys = lib().generateVAPIDKeys();
  settings.set(VAPID_KEY, { publicKey: keys.publicKey, privateKeyCipher: secrets.encrypt(keys.privateKey) });
  // Subscriptions are bound to the old public key and can no longer receive.
  db.run('DELETE FROM push_subscriptions');
  logger.info('Created the panel push key.');
  return keys;
}

function publicKey() {
  return vapidKeys().publicKey;
}

/** Default choices for a new device. */
function defaultPrefs() {
  return {
    categories: Object.fromEntries(CATEGORIES.map((c) => [c.key, c.default])),
    servers: 'all',
    quiet: { enabled: false, from: '22:00', to: '07:00', allowCritical: true },
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate and fill in a prefs object (unknown keys dropped). */
function normalizePrefs(input, base = defaultPrefs()) {
  const p = input && typeof input === 'object' ? input : {};
  const out = JSON.parse(JSON.stringify(base));
  if (p.categories && typeof p.categories === 'object') {
    for (const [k, v] of Object.entries(p.categories)) if (CATEGORY_KEYS.has(k)) out.categories[k] = Boolean(v);
  }
  if (p.servers === 'all') out.servers = 'all';
  else if (Array.isArray(p.servers)) {
    out.servers = [...new Set(p.servers.filter((s) => typeof s === 'string' && /^srv_[\w-]{1,40}$/.test(s)))].slice(
      0,
      500
    );
  }
  if (p.quiet && typeof p.quiet === 'object') {
    if (p.quiet.enabled !== undefined) out.quiet.enabled = Boolean(p.quiet.enabled);
    if (HHMM.test(String(p.quiet.from))) out.quiet.from = String(p.quiet.from);
    if (HHMM.test(String(p.quiet.to))) out.quiet.to = String(p.quiet.to);
    if (p.quiet.allowCritical !== undefined) out.quiet.allowCritical = Boolean(p.quiet.allowCritical);
  }
  return out;
}

/** Refuse anything that is not an HTTPS push-service URL on a public address. */
async function assertPushEndpoint(endpoint) {
  let u;
  try {
    u = new URL(String(endpoint));
  } catch {
    throw httpError(400, 'That push subscription is not valid. Turn notifications off and on again.');
  }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) {
    logger.debug('Refused a push subscription for an unknown push service.', { host: u.hostname });
    throw httpError(
      400,
      'This browser uses a push service the panel does not know, so it cannot send notifications here.'
    );
  }
  try {
    await assertPublicUrl(u.toString());
  } catch {
    throw httpError(400, 'That push service address could not be verified. Try again in a moment.');
  }
}

function rowToDevice(r) {
  return {
    id: r.id,
    deviceName: r.device_name,
    userAgent: r.user_agent,
    prefs: normalizePrefs(safeJsonParse(r.prefs_json, {}, { where: `push_subscriptions.prefs_json:${r.id}` })),
    createdAt: r.created_at,
    lastSentAt: r.last_sent_at,
    lastError: r.last_error,
    endpointHost: (() => {
      try {
        return new URL(r.endpoint).hostname;
      } catch {
        return '';
      }
    })(),
  };
}

function listDevices(userId) {
  return db.all('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at', userId).map(rowToDevice);
}

/** Find the device row for this browser's endpoint (so the page knows "this device"). */
function deviceForEndpoint(userId, endpoint) {
  const r = db.get(
    'SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
    userId,
    String(endpoint || '')
  );
  return r ? rowToDevice(r) : null;
}

/**
 * Add (or refresh) this device's subscription. Re-subscribing the same
 * endpoint keeps its choices; a browser that hands out a new endpoint gets a
 * new row with the choices it sent.
 */
/**
 * @param {string} userId
 * @param {{ subscription?: any, deviceName?: string, userAgent?: string, prefs?: any }} [input]
 */
async function subscribe(userId, { subscription, deviceName = '', userAgent = '', prefs } = {}) {
  const endpoint = subscription && subscription.endpoint;
  const keys = (subscription && subscription.keys) || {};
  await assertPushEndpoint(endpoint);
  if (
    !/^[A-Za-z0-9_-]{40,200}$/.test(String(keys.p256dh || '')) ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(String(keys.auth || ''))
  ) {
    throw httpError(400, 'That push subscription is missing its keys. Turn notifications off and on again.');
  }
  const name =
    String(deviceName || '')
      .trim()
      .slice(0, 60) || 'This Device';
  const existing = db.get('SELECT * FROM push_subscriptions WHERE endpoint = ?', endpoint);
  if (existing && existing.user_id !== userId) {
    // The same browser profile signed in as someone else: the device follows the new user.
    db.run('DELETE FROM push_subscriptions WHERE id = ?', existing.id);
  }
  const keep = existing && existing.user_id === userId ? existing : null;
  const merged = normalizePrefs(prefs, keep ? rowToDevice(keep).prefs : defaultPrefs());
  if (keep) {
    db.run(
      `UPDATE push_subscriptions SET p256dh = ?, auth_cipher = ?, device_name = ?, user_agent = ?, prefs_json = ?, failures = 0, last_error = NULL WHERE id = ?`,
      keys.p256dh,
      secrets.encrypt(keys.auth),
      name,
      String(userAgent).slice(0, 300),
      JSON.stringify(merged),
      keep.id
    );
    return rowToDevice(db.get('SELECT * FROM push_subscriptions WHERE id = ?', keep.id));
  }
  const id = `push_${nanoid(10)}`;
  db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth_cipher, device_name, user_agent, prefs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    endpoint,
    keys.p256dh,
    secrets.encrypt(keys.auth),
    name,
    String(userAgent).slice(0, 300),
    JSON.stringify(merged)
  );
  // A browser that keeps handing out new endpoints (cleared site data, a
  // reinstall) would otherwise pile up dead rows: keep the newest ones.
  db.run(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    userId,
    userId,
    MAX_DEVICES_PER_USER
  );
  logger.info('Turned push notifications on for a device.', { userId, deviceId: id });
  return rowToDevice(db.get('SELECT * FROM push_subscriptions WHERE id = ?', id));
}

function mustOwn(userId, deviceId) {
  const r = db.get('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?', deviceId, userId);
  if (!r) throw httpError(404, 'That device is not set up for notifications any more.');
  return r;
}

/**
 * @param {string} userId
 * @param {string} deviceId
 * @param {{ deviceName?: string, prefs?: any }} [input]
 */
function updateDevice(userId, deviceId, { deviceName, prefs } = {}) {
  const r = mustOwn(userId, deviceId);
  const current = rowToDevice(r);
  const name =
    deviceName === undefined ? current.deviceName : String(deviceName).trim().slice(0, 60) || current.deviceName;
  const merged = prefs === undefined ? current.prefs : normalizePrefs(prefs, current.prefs);
  db.run(
    'UPDATE push_subscriptions SET device_name = ?, prefs_json = ? WHERE id = ?',
    name,
    JSON.stringify(merged),
    r.id
  );
  return rowToDevice(db.get('SELECT * FROM push_subscriptions WHERE id = ?', r.id));
}

function removeDevice(userId, deviceId) {
  const r = mustOwn(userId, deviceId);
  db.run('DELETE FROM push_subscriptions WHERE id = ?', r.id);
  logger.info('Turned push notifications off for a device.', { userId, deviceId: r.id });
}

/** HH:MM in the panel's timezone right now. */
function nowHHMM(atMs = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: settings.getTimezone() || undefined,
    }).format(new Date(atMs));
  } catch {
    return new Date(atMs).toISOString().slice(11, 16);
  }
}

/** True while `now` falls inside from..to (which may wrap past midnight). */
function inQuietHours(quiet, now = nowHHMM()) {
  if (!quiet || !quiet.enabled || quiet.from === quiet.to) return false;
  return quiet.from < quiet.to ? now >= quiet.from && now < quiet.to : now >= quiet.from || now < quiet.to;
}

/** Should this device hear about `msg`? */
function wants(device, user, msg, now) {
  const p = device.prefs;
  if (!p.categories[msg.category]) return false;
  if (msg.serverId) {
    if (p.servers !== 'all' && !p.servers.includes(msg.serverId)) return false;
    if (!permissions.can(user, msg.serverId, 'view')) return false;
  } else if (user.role !== 'admin') {
    return false; // panel-wide events are admin business
  }
  if (inQuietHours(p.quiet, now) && !(p.quiet.allowCritical && CRITICAL.has(msg.category))) return false;
  return true;
}

/**
 * Send one payload to one subscription row. Resolves 'sent' | 'gone' | 'failed'.
 * A push service answering 404/410 means the device unsubscribed: the row goes.
 */
/**
 * @param {any} row
 * @param {object} payload
 * @param {{ urgency?: string, topic?: string }} [opts]
 */
async function deliver(row, payload, { urgency = 'normal', topic } = {}) {
  const auth = secrets.tryDecrypt(row.auth_cipher);
  if (!auth) {
    db.run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
    return 'gone';
  }
  const keys = vapidKeys();
  let details;
  try {
    details = lib().generateRequestDetails(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 24 * 3600,
        urgency,
        ...(topic ? { topic: topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      }
    );
  } catch (err) {
    db.run(
      'UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?',
      'Could not encrypt the notification.',
      row.id
    );
    logger.warn('Could not build a push notification for a device.', {
      deviceId: row.id,
      err: serializeError(err, { includeStack: false }),
    });
    return 'failed';
  }
  let res;
  try {
    await assertPushEndpoint(row.endpoint);
    res = await safeFetch(details.endpoint, {
      method: details.method,
      headers: details.headers,
      body: details.body,
      maxRedirects: 0,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    db.run(
      'UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?',
      'The push service could not be reached.',
      row.id
    );
    logger.debug('A push delivery could not reach the push service.', {
      deviceId: row.id,
      err: serializeError(err, { includeStack: false }),
    });
    return 'failed';
  } finally {
    // The body stream is not needed; let the socket go.
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  }
  if (res.status === 404 || res.status === 410) {
    db.run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
    logger.info('Removed a device the push service says is gone.', { deviceId: row.id, status: res.status });
    return 'gone';
  }
  if (!res.ok) {
    db.run(
      'UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?',
      `The push service refused the notification (HTTP ${res.status}).`,
      row.id
    );
    db.run('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?', row.id, MAX_FAILURES);
    return 'failed';
  }
  db.run(
    "UPDATE push_subscriptions SET last_sent_at = datetime('now'), failures = 0, last_error = NULL WHERE id = ?",
    row.id
  );
  return 'sent';
}

/** Send a test notification to one of the user's devices. */
async function sendTest(userId, deviceId) {
  const r = mustOwn(userId, deviceId);
  const result = await deliver(
    r,
    { title: 'Oxyx', body: 'Notifications reach this device.', url: '/settings/app', tag: 'oxyx-test' },
    { urgency: 'high' }
  );
  if (result === 'gone') throw httpError(410, 'This device stopped accepting notifications. Turn them on again.');
  if (result === 'failed')
    throw httpError(502, 'The push service did not accept the test notification. Try again in a moment.');
  return { ok: true };
}

// ---- The bridge: history events and player joins → pushes -----------------

const throttle = makeFailureThrottle();
/** @type {NodeJS.Timeout | null} */
let timer = null;
let polling = false;
let lastEventId = 0;
let lastJoinId = 0;

/** Turn a history row into a push message, or null when no category covers it. */
function messageForEvent(ev, serverNames) {
  const discord = require('../integrations/discord');
  const mapped = discord.EVENT_MAP[ev.type];
  if (!mapped) return null;
  const category = mapped[1];
  const serverName = ev.server_id ? serverNames.get(ev.server_id) || 'A server' : 'Oxyx';
  const title = `${serverName}: ${discord.titleFor(ev.type)}`;
  const url = ev.server_id
    ? category === 'crashes'
      ? `/servers/${ev.server_id}/history`
      : `/servers/${ev.server_id}`
    : '/activity';
  return {
    category,
    serverId: ev.server_id || null,
    urgency: CRITICAL.has(category) ? 'high' : 'normal',
    payload: {
      title,
      body: String(ev.summary || '').slice(0, 240),
      url,
      tag: `${ev.server_id || 'panel'}:${ev.type}`,
      critical: CRITICAL.has(category),
      actions: ev.server_id ? [{ action: 'open', title: 'Open Server' }] : [],
    },
    topic: `${ev.server_id || 'panel'}${category}`,
  };
}

function initialMark(key, table) {
  const maxId = db.get(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`)?.id || 0;
  const stored = Number(settings.get(key, 0)) || 0;
  if (!stored) return maxId;
  const timeCol = table === 'events' ? 'created_at' : 'ts';
  const cutoff =
    db.get(
      `SELECT COALESCE(MAX(id), 0) AS id FROM ${table} WHERE ${timeCol} < ?`,
      table === 'events'
        ? new Date(Date.now() - REPLAY_WINDOW_MINUTES * 60000).toISOString().replace('T', ' ').slice(0, 19)
        : new Date(Date.now() - REPLAY_WINDOW_MINUTES * 60000).toISOString()
    )?.id || 0;
  return Math.min(Math.max(stored, cutoff), maxId);
}

/** One pass: collect new events and joins, fan them out. Exported for tests. */
/** @param {{ now?: string }} [opts] `now` (HH:MM) pins the clock for quiet hours in tests */
async function pollOnce({ now } = {}) {
  const subs = db.all('SELECT * FROM push_subscriptions');
  const events = db.all('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 200', lastEventId);
  const joins = db.all("SELECT * FROM player_events WHERE id > ? AND type = 'join' ORDER BY id LIMIT 200", lastJoinId);
  if (events.length) lastEventId = events[events.length - 1].id;
  if (joins.length) lastJoinId = joins[joins.length - 1].id;
  settings.set(MARK_KEY, lastEventId);
  settings.set(JOIN_MARK_KEY, lastJoinId);
  if (!subs.length || (!events.length && !joins.length)) return { sent: 0 };

  const serverNames = new Map(db.all('SELECT id, display_name FROM servers').map((r) => [r.id, r.display_name]));
  const messages = events.map((ev) => messageForEvent(ev, serverNames)).filter(Boolean);
  for (const j of joins) {
    messages.push({
      category: 'joins',
      serverId: j.server_id,
      urgency: 'low',
      payload: {
        title: `${serverNames.get(j.server_id) || 'A server'}: Player Joined`,
        body: `${j.player} joined the game.`,
        url: `/servers/${j.server_id}/players`,
        tag: `${j.server_id}:join`,
        critical: false,
        actions: [{ action: 'open', title: 'Open Server' }],
      },
      topic: `${j.server_id}joins`,
    });
  }
  if (!messages.length) return { sent: 0 };

  const auth = require('./auth');
  const users = new Map();
  const userFor = (id) => {
    if (!users.has(id)) users.set(id, auth.getUser(id));
    return users.get(id);
  };
  const hhmm = now || nowHHMM();
  let sent = 0;
  const jobs = [];
  for (const row of subs) {
    const user = userFor(row.user_id);
    if (!user) continue;
    const device = rowToDevice(row);
    // Several matching events for one device in one pass collapse into the
    // newest per server and category (the tag replaces it on the device anyway).
    const picked = new Map();
    for (const m of messages) if (wants(device, user, m, hhmm)) picked.set(m.payload.tag, m);
    for (const m of picked.values()) jobs.push([row, m]);
  }
  for (let i = 0; i < jobs.length; i += 6) {
    const results = await Promise.all(
      jobs
        .slice(i, i + 6)
        .map(([row, m]) => module.exports.deliver(row, m.payload, { urgency: m.urgency, topic: m.topic }))
    );
    sent += results.filter((r) => r === 'sent').length;
  }
  return { sent };
}

function startPushBridge({ intervalMs = 5000 } = {}) {
  if (timer) return;
  lastEventId = initialMark(MARK_KEY, 'events');
  lastJoinId = initialMark(JOIN_MARK_KEY, 'player_events');
  timer = setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .then(() => throttle.ok(logger.info, 'The push notification bridge recovered.'))
      .catch((err) =>
        throttle.fail(logger.warn, 'A push notification bridge poll failed.', {
          err: serializeError(err, { includeStack: false }),
        })
      )
      .finally(() => {
        polling = false;
      });
  }, intervalMs);
  if (timer.unref) timer.unref();
  logger.debug('Started the push notification bridge.', { intervalMs });
}

function stopPushBridge() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: set the marks as if the bridge had just started. */
function _resetMarks() {
  lastEventId = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM events')?.id || 0;
  lastJoinId = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM player_events')?.id || 0;
}

module.exports = {
  CATEGORIES,
  PUSH_HOSTS,
  publicKey,
  defaultPrefs,
  normalizePrefs,
  assertPushEndpoint,
  listDevices,
  deviceForEndpoint,
  subscribe,
  updateDevice,
  removeDevice,
  sendTest,
  inQuietHours,
  messageForEvent,
  pollOnce,
  startPushBridge,
  stopPushBridge,
  deliver,
  _resetMarks,
};

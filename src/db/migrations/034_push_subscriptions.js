'use strict';

// Web Push subscriptions: one row per device a user turned notifications on
// for. The endpoint is the push service URL for that device; p256dh and the
// auth secret are the keys the payload is encrypted to. The auth secret is
// stored encrypted at rest (services/secrets). prefs_json holds what this
// device wants to hear about (categories, servers, quiet hours).

function up(db) {
  db.exec(`
    CREATE TABLE push_subscriptions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint     TEXT NOT NULL UNIQUE,
      p256dh       TEXT NOT NULL,
      auth_cipher  TEXT NOT NULL,
      device_name  TEXT NOT NULL DEFAULT '',
      user_agent   TEXT NOT NULL DEFAULT '',
      prefs_json   TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_sent_at TEXT,
      last_error   TEXT,
      failures     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);
}

module.exports = { up };

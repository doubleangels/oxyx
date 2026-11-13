'use strict';

// A crash alert links the crash report written nearest to it, within five
// minutes, found by a windowed indexed query (F-22).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const { reportNear } = require('../src/services/healthAlerts');

db.run(
  `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
   VALUES ('srv_rn', 'x', 'PAPER', 27900, 28900, 'x', 1024, 1536)`
);
const add = (id, iso) =>
  db.run(
    `INSERT INTO crash_reports (id, server_id, filename, file_mtime, size_bytes, summary, exception, suspected_json)
     VALUES (?, 'srv_rn', ?, ?, 1, 's', ?, '[]')`,
    id,
    `${id}.txt`,
    iso,
    `ex-${id}`
  );

test('reportNear picks the nearest report inside the window and ignores the rest', () => {
  add('cr_far_before', '2026-01-01T11:50:00.000Z');
  add('cr_near', '2026-01-01T12:01:00.000Z');
  add('cr_nearer', '2026-01-01T11:59:30.000Z');
  add('cr_far_after', '2026-01-01T12:06:00.000Z');
  const hit = reportNear('srv_rn', '2026-01-01 12:00:00');
  assert.equal(hit.id, 'cr_nearer');
  assert.equal(hit.exception, 'ex-cr_nearer');
  assert.equal(reportNear('srv_rn', '2026-01-01 13:00:00'), null, 'nothing within five minutes');
  assert.equal(reportNear('srv_rn', 'not a date'), null);
});

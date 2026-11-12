'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('../src/db/migrate');
const db = require('../src/db');

const snapDir = () => require('../src/storage/pathGuard').dataPath('backups', '_panel');
const preMigrateSnaps = () =>
  fs.existsSync(snapDir()) ? fs.readdirSync(snapDir()).filter((f) => f.startsWith('pre-migrate-')) : [];

test('migrate() applies the full schema from an empty DB, then is idempotent', () => {
  const first = migrate();
  assert.ok(first > 0, 'first run applies at least one migration');
  assert.deepEqual(preMigrateSnaps(), [], 'a fresh install takes no pre-migration snapshot');

  const second = migrate();
  assert.equal(second, 0, 'a second run applies nothing (idempotent)');
});

test('core tables exist after migration', () => {
  migrate();
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  for (const t of ['servers', 'settings', 'schema_migrations', 'player_events']) {
    assert.ok(tables.has(t), `expected table ${t}`);
  }
});

test('a renumbered migration recorded under its legacy filename is aliased, not re-run', () => {
  // Simulate an install that shipped before the 010-015 renumber: the work for
  // 011_wizard_chat exists but is recorded as 010_wizard_chat.
  db.run('DELETE FROM schema_migrations WHERE version = ?', '011_wizard_chat');
  db.run("INSERT INTO schema_migrations (version) VALUES ('010_wizard_chat')");
  try {
    const applied = migrate();
    assert.equal(applied, 0, 'the aliased migration is not re-run');
    const rows = db.all('SELECT version FROM schema_migrations').map((r) => r.version);
    assert.ok(rows.includes('011_wizard_chat'), 'the current filename is recorded');
    assert.ok(rows.includes('010_wizard_chat'), 'the legacy filename stays recorded');
  } finally {
    // Restore the clean post-migration state for the tests that follow.
    db.run('DELETE FROM schema_migrations WHERE version = ?', '010_wizard_chat');
    db.run('DELETE FROM schema_migrations WHERE version = ?', '011_wizard_chat');
    db.run("INSERT INTO schema_migrations (version) VALUES ('011_wizard_chat')");
  }
});

test('a duplicate migration number prefix is a loud boot failure, not a silent reorder', () => {
  // A throwaway folder, NOT src/db/migrations: test files run in parallel, and a
  // stray 999_* file in the real folder breaks every other test that migrates or
  // lists it while this one is running.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-migrations-'));
  try {
    fs.writeFileSync(path.join(dir, '999_dup_guard_a.js'), 'exports.up = () => {};\n');
    fs.writeFileSync(path.join(dir, '999_dup_guard_b.js'), 'exports.up = () => {};\n');
    assert.throws(() => migrate({ dir }), /Duplicate migration number 999/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The real folder was never touched, so a normal run is still idempotent.
  assert.equal(migrate(), 0);
});

test('a throwaway migrations folder is applied and recorded like the real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-migrations-'));
  try {
    fs.writeFileSync(
      path.join(dir, '900_probe.js'),
      "exports.up = (db) => db.exec('CREATE TABLE IF NOT EXISTS migrate_probe (id INTEGER)');\n"
    );
    assert.equal(migrate({ dir }), 1, 'the probe migration is applied');
    assert.equal(migrate({ dir }), 0, 'and not applied twice');
    assert.ok(db.get("SELECT 1 AS x FROM schema_migrations WHERE version = '900_probe'"));
  } finally {
    db.run("DELETE FROM schema_migrations WHERE version = '900_probe'");
    db.exec('DROP TABLE IF EXISTS migrate_probe');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending migrations on an existing database are preceded by a snapshot of it (F-23)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-migrations-'));
  const before = preMigrateSnaps().length;
  try {
    fs.writeFileSync(
      path.join(dir, '901_snap_probe.js'),
      "exports.up = (db) => db.exec('CREATE TABLE IF NOT EXISTS snap_probe (id INTEGER)');\n"
    );
    assert.equal(migrate({ dir }), 1);
    const snaps = preMigrateSnaps();
    assert.equal(snaps.length, before + 1, 'one snapshot for this upgrade');
    const newest = snaps.sort().at(-1);
    assert.match(newest, /^pre-migrate-v\d+\.\d+\.\d+-[\d-]+\.db$/);
    // The copy is the database as it was BEFORE the migration ran.
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(path.join(snapDir(), newest), { readOnly: true });
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    copy.close();
    assert.ok(tables.includes('servers'));
    assert.ok(!tables.includes('snap_probe'));
    assert.equal(migrate({ dir }), 0);
    assert.equal(preMigrateSnaps().length, before + 1, 'nothing pending, no new snapshot');
  } finally {
    db.run("DELETE FROM schema_migrations WHERE version = '901_snap_probe'");
    db.exec('DROP TABLE IF EXISTS snap_probe');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction() rolls back on throw', () => {
  migrate();
  db.run('CREATE TABLE IF NOT EXISTS _tx_probe (id INTEGER PRIMARY KEY, v TEXT)');
  db.run('DELETE FROM _tx_probe');
  assert.throws(() =>
    db.transaction(() => {
      db.run('INSERT INTO _tx_probe (v) VALUES (?)', 'x');
      throw new Error('boom');
    })
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM _tx_probe').n, 0, 'insert was rolled back');
});

test('migration numbers run 001..N with no gaps or duplicates', () => {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const nums = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.js$/.test(f))
    .map((f) => Number(f.slice(0, 3)))
    .sort((a, b) => a - b);
  assert.deepEqual(
    nums,
    nums.map((_, i) => i + 1),
    'renumbering? add the old filename to LEGACY_MIGRATION_ALIASES in src/db/migrate.js'
  );
});

test('every legacy alias points at a migration file that exists', () => {
  const { LEGACY_MIGRATION_ALIASES } = require('../src/db/migrate');
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.js$/, '')));
  for (const current of Object.keys(LEGACY_MIGRATION_ALIASES)) assert.ok(files.has(current), current);
});

test('an install that recorded the pre-renumber names does not re-run them', () => {
  for (const [current, [old]] of [
    ['030_port_change_immediate', ['031_port_change_immediate']],
    ['031_alert_dismissals', ['033_alert_dismissals']],
    ['032_internal_port_bind', ['034_internal_port_bind']],
  ]) {
    db.run('DELETE FROM schema_migrations WHERE version = ?', current);
    db.run('INSERT INTO schema_migrations (version) VALUES (?)', old);
  }
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, container_id, pending_recreate)
     VALUES ('srv_alias', 'a', 'PAPER', 47100, 48100, 'x', 1024, 1536, 'cid', 0)`
  );
  try {
    assert.equal(migrate(), 0, 'nothing re-runs (alert_dismissals would fail to CREATE TABLE twice)');
    assert.equal(db.get("SELECT pending_recreate FROM servers WHERE id = 'srv_alias'").pending_recreate, 0);
  } finally {
    db.run("DELETE FROM servers WHERE id = 'srv_alias'");
  }
});

test('a migration that breaks a foreign key is rolled back; an async one is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-migrations-'));
  try {
    fs.writeFileSync(
      path.join(dir, '950_bad_fk.js'),
      `exports.up = (db) => {
        db.exec("CREATE TABLE fk_probe (id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id))");
        db.exec("PRAGMA defer_foreign_keys = ON");
        db.run("INSERT INTO fk_probe (user_id) VALUES ('usr_missing')");
      };\n`
    );
    assert.throws(() => migrate({ dir, snapshot: false }), /broken foreign key/);
    assert.equal(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'fk_probe'"), undefined, 'rolled back');
    assert.equal(db.get("SELECT 1 AS x FROM schema_migrations WHERE version = '950_bad_fk'"), undefined);
    fs.rmSync(path.join(dir, '950_bad_fk.js'));
    fs.writeFileSync(path.join(dir, '951_async.js'), 'exports.up = async () => {};\n');
    assert.throws(() => migrate({ dir, snapshot: false }), /must be synchronous/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('004 collapses duplicate library rows in one pass and re-points their references', () => {
  const { up } = require('../src/db/migrations/004_library_dedup');
  db.exec('DROP INDEX IF EXISTS uniq_library_sha_cat');
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES ('srv_dedup', 'd', 'PAPER', 47200, 48200, 'x', 1024, 1536)`
  );
  for (const id of ['lib_a1', 'lib_a2', 'lib_b1']) {
    db.run(
      `INSERT INTO library_files (id, category, name, filename, rel_path, sha256, size_bytes) VALUES (?, 'mod', 'x', ?, ?, ?, 1)`,
      id,
      `${id}.jar`,
      `library/mods/${id}.jar`,
      id.startsWith('lib_a') ? 'a'.repeat(64) : 'b'.repeat(64)
    );
  }
  db.run(
    `INSERT INTO server_content (id, server_id, library_id, kind, managed_by, name, filename) VALUES ('sc_d', 'srv_dedup', 'lib_a2', 'mod', 'overlay', 'x', 'x.jar')`
  );
  try {
    up(db);
    const ids = db.all("SELECT id FROM library_files WHERE id LIKE 'lib_%' ORDER BY id").map((r) => r.id);
    assert.deepEqual(ids, ['lib_a1', 'lib_b1']);
    assert.equal(db.get("SELECT library_id FROM server_content WHERE id = 'sc_d'").library_id, 'lib_a1');
  } finally {
    db.run("DELETE FROM server_content WHERE id = 'sc_d'");
    db.run("DELETE FROM library_files WHERE id IN ('lib_a1', 'lib_b1')");
    db.run("DELETE FROM servers WHERE id = 'srv_dedup'");
  }
});

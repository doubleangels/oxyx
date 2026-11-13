'use strict';

// Tiny versioned migration runner. Migrations live in ./migrations as
// NNN_name.js files exporting { up(db) }. Applied in filename order inside a
// transaction; applied versions recorded in schema_migrations.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const logger = require('../logger')(path.basename(__filename));

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Before a later release renumbered duplicate 3-digit prefixes (010-015) to
// unique ascending values, schema_migrations recorded those migrations under
// their old filenames. A renamed file would otherwise read as "not applied" and
// re-run against a database that already has its work done. Legacy aliases map
// each current filename back to the filename it shipped under; if any old name
// is already recorded, the migration is treated as applied and re-recorded
// under its current name. Once every installing panel has passed through this
// release the map could be dropped, but keeping it is harmless - the old
// versions never appear on a fresh install.
const LEGACY_MIGRATION_ALIASES = {
  '011_wizard_chat': ['010_wizard_chat'],
  '012_player_notes': ['011_player_notes'],
  '013_wizard_invocation_name': ['011_wizard_invocation_name'],
  '014_player_events_index': ['012_player_events_index'],
  '015_wizard_powers': ['012_wizard_powers'],
  '016_session_user_id': ['013_session_user_id'],
  '017_wizard_outreach': ['013_wizard_outreach'],
  '018_backup_pre_restore_reason': ['014_backup_pre_restore_reason'],
  '019_wizard_power_controllers': ['014_wizard_power_controllers'],
  '020_api_tokens': ['015_api_tokens'],
  '021_content_ignored_update': ['015_content_ignored_update'],
  '022_crash_mclogs': ['015_crash_mclogs'],
  '023_datapack_jar_cleanup': ['016_datapack_jar_cleanup'],
  '024_update_check_ignore': ['017_update_check_ignore'],
  // Later renumber that closed the gaps left at 030 and 032 (numbers that never
  // shipped as files), so the sequence runs 001..N without holes.
  '030_port_change_immediate': ['031_port_change_immediate'],
  '031_alert_dismissals': ['033_alert_dismissals'],
  '032_internal_port_bind': ['034_internal_port_bind'],
};

const PRE_MIGRATE_KEEP = 5;

/**
 * Copy the database aside before an upgrade changes its schema, so a bad
 * migration leaves more than yesterday's daily snapshot to go back to.
 * VACUUM INTO writes a consistent, checkpointed copy. It blocks, but this runs
 * once at boot before the panel listens. Kept apart from the daily
 * `panel-*.db` snapshots (their own prefix and pruning), newest few only.
 * @returns {string | null} the snapshot path, or null when it could not be made
 */
function snapshotBeforeMigrating(pending) {
  try {
    const { dataPath } = require('../storage/pathGuard');
    const { version } = require('../../package.json');
    const dir = dataPath('backups', '_panel');
    fs.mkdirSync(dir, { recursive: true });
    // Milliseconds too: VACUUM INTO refuses to overwrite, and two boots (or
    // tests) can land in the same second.
    const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
    const file = path.join(dir, `pre-migrate-v${version}-${stamp}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    logger.info('Snapshotted the panel database before applying migrations.', {
      pending,
      dir: 'data/backups/_panel',
    });
    const old = fs
      .readdirSync(dir)
      .filter((f) => /^pre-migrate-.*\.db$/.test(f))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - PRE_MIGRATE_KEEP)))
      fs.rmSync(path.join(dir, f), { force: true });
    return file;
  } catch (err) {
    // A failed copy must not stop the upgrade: the daily snapshots still exist.
    logger.warn('Could not snapshot the panel database before migrating.', { err: err && err.message });
    return null;
  }
}

/**
 * Apply every migration not yet recorded. `dir` exists so a test can point the
 * runner at a throwaway folder instead of touching the real migrations.
 * @param {{ dir?: string, snapshot?: boolean }} [opts] `snapshot: false` skips the pre-migration copy
 */
function migrate({ dir = MIGRATIONS_DIR, snapshot = true } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.js$/.test(f))
    .sort();

  // Duplicate number prefixes were how the pre-renumber drift sneaked in; make
  // a recurred one a loud boot failure instead of a silent ordering change.
  const seenNumbers = new Map();
  for (const file of files) {
    const prefix = file.slice(0, 3);
    const prior = seenNumbers.get(prefix);
    if (prior) {
      throw new Error(
        `Duplicate migration number ${prefix}: "${prior}" and "${file}" both use it. ` +
          'Migration files must each have a unique 3-digit prefix (they are applied in filename order).'
      );
    }
    seenNumbers.set(prefix, file);
  }

  // An existing database about to change shape gets a copy first. A fresh
  // install (nothing applied yet) has nothing worth keeping.
  const pending = files.filter((f) => {
    const v = f.replace(/\.js$/, '');
    const legacy = LEGACY_MIGRATION_ALIASES[v];
    return !applied.has(v) && !(legacy && legacy.some((old) => applied.has(old)));
  });
  if (applied.size > 0 && pending.length > 0 && snapshot) snapshotBeforeMigrating(pending.length);

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.js$/, '');
    if (applied.has(version)) continue;
    const legacy = LEGACY_MIGRATION_ALIASES[version];
    if (legacy && legacy.some((old) => applied.has(old))) {
      // The work shipped under old = <legacy>; just track it under version.
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', version);
      applied.add(version);
      logger.info('Re-recorded a renumbered migration under its current filename.', { version, legacy });
      continue;
    }
    const { up } = require(path.join(dir, file));
    db.transaction(() => {
      // Violations that predate this migration (an old install can carry a
      // dangling reference) must not block the upgrade, only new ones.
      const fkKey = (r) => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`;
      const before = new Set(db.all('PRAGMA foreign_key_check').map(fkKey));
      const result = up(db);
      // db.transaction() commits as soon as up() returns. An async up() would
      // commit before its awaited work ran, outside the transaction.
      if (result && typeof result.then === 'function') {
        throw new Error(`Migration ${version} returned a promise. Migrations must be synchronous.`);
      }
      // A migration that rebuilds or rewires tables must not leave a dangling
      // reference behind. Checked before commit, so a violation rolls it back.
      const broken = db.all('PRAGMA foreign_key_check').filter((r) => !before.has(fkKey(r)));
      if (broken.length > 0) {
        throw new Error(
          `Migration ${version} left ${broken.length} broken foreign key reference(s), first in table ${broken[0].table}. Nothing was changed.`
        );
      }
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', version);
    });
    count += 1;
    logger.info('Applied a database migration.', { version });
  }
  // Fresh statistics for the query planner after the schema changed. Cheap, and
  // a no-op when nothing moved enough to matter.
  if (count > 0) db.exec('PRAGMA optimize');
  return count;
}

module.exports = { migrate, LEGACY_MIGRATION_ALIASES };

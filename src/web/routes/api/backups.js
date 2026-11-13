'use strict';

// Backups and backup retention.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const fs = require('node:fs');
const { z } = require('zod');
const tasks = require('../../../services/tasks');
const db = require('../../../db');
const httpError = require('../../../utils/httpError');
const { dataPath } = require('../../../storage/pathGuard');
const backups = require('../../../services/backups');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const { requireCap, backupServerId } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer } = require('./shared');

// ---- Backups ----
// Long operation - returns {ok, taskId}; task result: {id, filename, size}.
router.post(
  '/servers/:id/backups',
  requireCap('backups'),
  asyncHandler((req, res, next) => {
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const note = String(req.body?.note || '');
    const shrinkAfter = Boolean(req.body?.shrink);
    const taskId = tasks.run(`Backing up ${server.display_name}…`, { serverId: server.id, actor }, async (t) => {
      t.step('Preparing the backup…');
      const backup = await backups.createBackup(server.id, { reason: 'manual', actor, note, shrinkAfter, task: t });
      return { id: backup.id, filename: backup.filename, size: backup.size_bytes };
    });
    res.status(202).json({ ok: true, taskId });
  })
);

// Long operation - returns {ok, taskId}. Stops the server, takes a safety
// backup, wipes the dir and extracts the archive.
router.post(
  '/servers/:id/backups/:backupId/restore',
  requireCap('backups'),
  asyncHandler((req, res, next) => {
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const backupId = req.params.backupId;
    const taskId = tasks.run(
      `Restoring backup on ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Checking the backup…');
        await backups.restoreBackup(server.id, backupId, { actor, task: t });
        return { ok: true };
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

// Download a backup archive. Admin/operator only - the archive contains the
// whole server dir, including server.properties (plaintext rcon.password), so a
// read-only viewer must never be able to pull it.
router.get(
  '/backups/:backupId/download',
  requireCap('backups', { resolve: backupServerId }),
  asyncHandler((req, res, next) => {
    const backup = db.get('SELECT * FROM backups WHERE id = ?', req.params.backupId);
    if (!backup) throw Object.assign(new Error('Backup not found.'), { status: 404 });
    const abs = dataPath(backup.rel_path);
    if (!fs.existsSync(abs)) throw Object.assign(new Error('Backup archive is missing on disk.'), { status: 404 });
    res.download(abs, backup.filename);
  })
);

// Read-only dry-run restore: reads every entry and checks its CRC. Synchronous
// (ponytail: move to tasks.run if verifying huge archives outlasts request timeouts).
router.post(
  '/backups/:backupId/verify',
  requireCap('backups', { resolve: backupServerId }),
  asyncHandler(async (req, res) => {
    res.json(await backups.verifyBackup(req.params.backupId, { actor: req.user.username }));
  })
);

router.delete(
  '/backups/:backupId',
  requireCap('backups', { resolve: backupServerId }),
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, ...(await backups.deleteBackupByUser(req.params.backupId, { actor: req.user.username })) });
  })
);

// Rename a backup archive (display + on-disk filename) and/or edit its note.
router.patch(
  '/backups/:backupId',
  requireCap('backups', { resolve: backupServerId }),
  asyncHandler(async (req, res, next) => {
    const { filename, note } = z
      .object({
        filename: z.string().trim().max(120).optional(),
        note: z.string().trim().max(200, 'Keep the note under 200 characters.').optional(),
      })
      .parse(req.body);
    /** @type {any} */
    let updated = null;
    if (filename !== undefined) {
      updated = await backups.renameBackup(req.params.backupId, filename, { actor: req.user.username });
    }
    if (note !== undefined) updated = backups.setBackupNote(req.params.backupId, note, { actor: req.user.username });
    if (!updated) throw httpError(400, 'Nothing to change.');
    res.json({
      ok: true,
      backup: {
        id: updated.id,
        filename: updated.filename,
        note: updated.note || '',
        size_bytes: updated.size_bytes,
        reason: updated.reason,
        created_at: updated.created_at,
      },
    });
  })
);

// ---- Backup retention policy (count caps + age / total-size ceilings) ----
const backupRetention = require('../../../services/backupRetention');
const retentionPatchSchema = z
  .object({
    keepScheduled: z.coerce.number().int().min(1).max(500).optional(),
    keepPreUpdate: z.coerce.number().int().min(1).max(500).optional(),
    keepManual: z.coerce.number().int().min(1).max(500).optional(),
    keepPreRestore: z.coerce.number().int().min(1).max(500).optional(),
    maxAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
    maxTotalGb: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .strict();
// A server's override is per key: null (or "", a blank form field) removes that
// key, so it follows the panel-wide value again.
const retentionServerPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(retentionPatchSchema.shape).map(([key, schema]) => [
        key,
        z.preprocess((v) => (v === '' ? null : v), schema.nullable()),
      ])
    )
  )
  .strict();

router.get('/backups/retention', requireRoleKeys('admin'), (req, res) => {
  res.json({ ok: true, defaults: backupRetention.DEFAULTS, global: backupRetention.globalConfig() });
});

// The panel-wide policy has no blank: z.coerce would quietly turn null into 0
// ("no age limit"), so say so instead.
function parseGlobalRetention(body = {}) {
  if (Object.values(body).some((v) => v === null || v === '')) {
    throw httpError(400, 'Panel-wide retention values cannot be blank. Use 0 for no age or size limit.');
  }
  return retentionPatchSchema.parse(body);
}

// A server's body: { reset: true } clears its limits, anything else is a patch
// ({ reset: false } is just a patch with nothing to reset).
function parseServerRetention(body = {}) {
  const { reset, ...patch } = body;
  // Form posts and older scripts send "true" / 1; all of them mean reset.
  if ([true, 'true', 1, '1'].includes(reset)) return null;
  if (![undefined, false, 'false', 0, '0'].includes(reset)) {
    throw httpError(400, 'Send reset as true or false.');
  }
  return retentionServerPatchSchema.parse(patch);
}

// "Remove now" names what its preview showed - by the preview's token (the UI),
// or the ids themselves (scripts) - and nothing else is deleted. Neither means
// everything over the saved limits.
const applySchema = z
  .object({ token: z.string().max(64).optional(), ids: z.array(z.string().max(64)).max(10000).optional() })
  .strict();
const onlyIdsFrom = (body) => {
  const { token, ids } = applySchema.parse(body || {});
  if (token) {
    const listed = backups.previewIds(token);
    if (!listed) throw httpError(409, 'That check is too old. Save again to see what would be removed now.');
    return listed;
  }
  return ids ? new Set(ids) : null;
};

router.post(
  '/backups/retention',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const patch = parseGlobalRetention(req.body || {});
    res.json({ ok: true, global: backupRetention.setGlobal(patch) });
  })
);

// What a retention change would remove right now, before it is saved, so the
// settings UI can offer "remove now" or "from the next backup". Nothing is
// deleted. A global change is previewed on every server: overrides are
// partial, so it reaches servers with an override for the keys they don't set.
const liveServerIds = () => db.all('SELECT id FROM servers WHERE deleted_at IS NULL').map((r) => r.id);

router.post(
  '/backups/retention/preview',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const patch = parseGlobalRetention(req.body || {});
    res.json({
      ok: true,
      ...backups.previewRetention(liveServerIds(), (id) => backupRetention.effectiveIf(id, { global: patch })),
    });
  })
);

// Apply the saved policy now on every server instead of after each one's next
// backup, limited to the previewed ids when given. Servers busy with another
// action are skipped and counted.
router.post(
  '/backups/retention/apply',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    const { deleted, skipped } = await backups.applyRetention(liveServerIds(), {
      actor: req.user.username,
      onlyIds: onlyIdsFrom(req.body),
    });
    res.json({ ok: true, deleted, skipped: skipped.length });
  })
);

router.get('/servers/:id/backups/retention', requireRoleKeys('admin'), (req, res) => {
  requireServer(req.params.id);
  res.json({
    ok: true,
    defaults: backupRetention.DEFAULTS,
    global: backupRetention.globalConfig(),
    effective: backupRetention.effective(req.params.id),
    override: backupRetention.overrideFor(req.params.id),
  });
});

router.post(
  '/servers/:id/backups/retention/preview',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const server = parseServerRetention(req.body || {});
    res.json({
      ok: true,
      ...backups.previewRetention([req.params.id], (id) => backupRetention.effectiveIf(id, { server })),
    });
  })
);

router.post(
  '/servers/:id/backups/retention/apply',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const { deleted, skipped } = await backups.applyRetention([req.params.id], {
      actor: req.user.username,
      onlyIds: onlyIdsFrom(req.body),
    });
    if (skipped.length) {
      throw httpError(409, 'Another action is running on this server. Try again when it finishes.');
    }
    res.json({ ok: true, deleted });
  })
);

router.post(
  '/servers/:id/backups/retention',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const effective = backupRetention.setServer(req.params.id, parseServerRetention(req.body || {}));
    res.json({ ok: true, effective });
  })
);

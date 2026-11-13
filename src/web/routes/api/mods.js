// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Mods manager, version compatibility, manual-download resolver, mod-zip importer.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const multer = require('multer');
const { z } = require('zod');
const servers = require('../../../services/servers');
const tasks = require('../../../services/tasks');
const db = require('../../../db');
const httpError = require('../../../utils/httpError');
const { dataPath } = require('../../../storage/pathGuard');
const logger = require('../../../logger')('api');
const { serializeError } = require('../../../utils/logSanitize');
const { requireCap } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer, zipImportUpload, zipTokenSchema } = require('./shared');

// ---- Mods manager ----
const mods = require('../../../services/mods');

// Applying a mod update only swaps the jar on disk; the running JVM keeps the
// old classes until the server restarts. Restart only when it's actually up -
// a stopped server picks the new jars up on its next start.
const MOD_RESTART_STATES = new Set(['running', 'starting', 'unhealthy', 'stalled']);
async function restartAfterModUpdate(serverId, actor) {
  const server = servers.getServer(serverId);
  if (!server || !MOD_RESTART_STATES.has(server.status)) return false;
  await servers.restartServer(serverId, { actor });
  return true;
}

router.get(
  '/servers/:id/mods',
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, mods: await mods.listContent(req.params.id) });
  })
);

router.post(
  '/servers/:id/mods',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const { url, kind, ignoreVersion } = z
      .object({
        url: z.string().trim().min(3).max(500),
        kind: z.enum(['mod', 'plugin', 'datapack', 'resourcepack']).optional(),
        // User explicitly accepted the risk of installing a build not listed
        // as compatible with this server's exact MC version and/or loader.
        ignoreVersion: z.boolean().optional(),
      })
      .parse(req.body);
    const actor = req.user.username;
    const result = await tasks.track('Installing from a link…', { serverId: req.params.id, actor }, () =>
      mods.installFromUrl(req.params.id, url, { actor, kind, ignoreVersion })
    );
    res.status(201).json({
      ok: true,
      installed: {
        name: result.library.name,
        filename: result.filename,
        version: result.library.version,
        versionOverridden: result.versionOverridden,
        loaderOverridden: result.loaderOverridden,
      },
    });
  })
);

// Update one overlay mod to its latest checked version. Accepts the
// installed filename ({file}) or the server_content row id ({contentId}).
// Re-downloads through the platform (pinned to the checked version id),
// replaces the old file, preserves the enabled/disabled state, then restarts
// the server if it was running so the new jar is actually loaded.
router.post(
  '/servers/:id/mods/update',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const { file, contentId } = z
      .object({
        file: z.string().min(1).max(200).optional(),
        contentId: z.string().trim().max(40).optional(),
      })
      .refine((v) => Boolean(v.file) || Boolean(v.contentId), { message: 'Provide either a file or a content ID.' })
      .parse(req.body);
    const server = requireServer(req.params.id);
    const actor = req.user.username;

    const { result, restarted } = await tasks.track('Updating a mod…', { serverId: server.id, actor }, async (t) => {
      const r = await mods.applyOverlayUpdate(server.id, { file, contentId }, { actor });
      t.step('Restarting the server…');
      return { result: r, restarted: await restartAfterModUpdate(server.id, actor) };
    });
    res.json({
      ok: true,
      restarted,
      installed: {
        name: result.name,
        filename: result.filename,
        version: result.version,
        enabled: result.wasEnabled,
      },
    });
  })
);

// Undo an update: put one overlay mod back on the build it came from. The old
// build is still in the library, so this is a local reinstall, and the build
// being left behind is marked ignored so the next daily check does not offer
// it straight back.
router.post(
  '/servers/:id/mods/revert',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const { file, contentId } = z
      .object({
        file: z.string().min(1).max(200).optional(),
        contentId: z.string().trim().max(40).optional(),
      })
      .refine((v) => Boolean(v.file) || Boolean(v.contentId), { message: 'Provide either a file or a content ID.' })
      .parse(req.body);
    const server = requireServer(req.params.id);
    const actor = req.user.username;

    const { result, restarted } = await tasks.track('Reverting a mod…', { serverId: server.id, actor }, async (t) => {
      const r = await mods.revertOverlayUpdate(server.id, { file, contentId }, { actor });
      t.step('Restarting the server…');
      return { result: r, restarted: await restartAfterModUpdate(server.id, actor) };
    });
    res.json({
      ok: true,
      restarted,
      installed: {
        name: result.name,
        filename: result.filename,
        version: result.version,
        enabled: result.wasEnabled,
      },
      revertedFrom: result.revertedFrom,
    });
  })
);

// Ignore / un-ignore the currently-offered update for one overlay mod. An
// ignored build stops showing on the mods tab, the Updates page and the
// sidebar count; a later, genuinely newer build re-surfaces on its own.
router.post(
  '/servers/:id/mods/ignore-update',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const { file, contentId, ignore } = z
      .object({
        file: z.string().min(1).max(200).optional(),
        contentId: z.string().trim().max(40).optional(),
        ignore: z.boolean(),
      })
      .refine((v) => Boolean(v.file) || Boolean(v.contentId), { message: 'Provide either a file or a content ID.' })
      .parse(req.body);
    const server = requireServer(req.params.id);
    const out = mods.setIgnoredUpdate(server.id, { file, contentId }, { ignore, actor: req.user.username });
    res.json({ ok: true, ...out });
  })
);

// Apply every non-ignored overlay-mod update for this server, then restart it
// once (if it was running). Long operation - returns {ok, taskId}; the task
// result is { updated, failed, restarted }.
router.post(
  '/servers/:id/mods/update-all',
  requireCap('content'),
  asyncHandler((req, res, next) => {
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const taskId = tasks.run(`Updating mods on ${server.display_name}…`, { serverId: server.id, actor }, async (t) => {
      const rows = db.all(
        `SELECT sc.id, sc.name
             FROM server_content sc
             JOIN library_files lf ON lf.id = sc.library_id
             JOIN update_checks uc ON uc.subject_type = 'content' AND uc.subject_id = sc.id
            WHERE sc.server_id = ? AND sc.managed_by = 'overlay' AND lf.project_id IS NOT NULL
              AND uc.latest_name IS NOT NULL AND uc.latest_name != sc.version
              AND (sc.ignored_update_version IS NULL OR sc.ignored_update_version != uc.latest_name)`,
        server.id
      );
      const updated = [];
      const failed = [];
      for (const row of rows) {
        t.step(`Updating ${row.name}…`);
        try {
          const r = await mods.applyOverlayUpdate(server.id, { contentId: row.id }, { actor });
          updated.push({ name: r.name, version: r.version });
        } catch (err) {
          failed.push({ name: row.name, error: err.message });
        }
      }
      let restarted = false;
      if (updated.length) {
        t.step('Restarting server…');
        restarted = await restartAfterModUpdate(server.id, actor);
      }
      return { updated, failed, restarted };
    });
    res.status(202).json({ ok: true, taskId });
  })
);

router.post(
  '/servers/:id/mods/toggle',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const { file, enabled } = z.object({ file: z.string().min(1).max(200), enabled: z.boolean() }).parse(req.body);
    res.json({ ok: true, ...(await mods.setEnabled(req.params.id, file, enabled, { actor: req.user.username })) });
  })
);

router.delete(
  '/servers/:id/mods/:file',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, ...(await mods.removeContent(req.params.id, req.params.file, { actor: req.user.username })) });
  })
);

// ---- Version compatibility (#52) ----
// The per-server Updates tab. A scan reads every jar and asks the registries,
// so it only ever runs when someone asks for it; these routes hand back the
// stored result and its progress, which outlive both the request and the
// process that started the scan.
const compat = require('../../../services/compat');

/**
 * The report WITHOUT the per-version mod lists. A 400-mod pack across 30
 * candidate versions is 12,000 entries - the page asks for one version's list
 * at a time instead (route below).
 */
function compatSummary(state) {
  if (!state.report) return state;
  const { versions, unknown, unchecked, ...rest } = state.report;
  return {
    ...state,
    report: {
      ...rest,
      // The unknown / unchecked lists are per server, not per version, and are
      // the short ones that actually need acting on - they ship whole.
      unknown,
      unchecked: unchecked || [],
      versions: versions.map(({ ready, missing, ...v }) => v),
    },
  };
}

router.get(
  '/servers/:id/compat',
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    res.json({ ok: true, ...compatSummary(compat.getReport(req.params.id)) });
  })
);

router.get(
  '/servers/:id/compat/versions/:version',
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const version = z
      .string()
      .regex(/^[\w.-]{1,32}$/)
      .parse(req.params.version);
    const state = compat.getReport(req.params.id);
    const entry = state.report && state.report.versions.find((v) => v.version === version);
    if (!entry) throw httpError(404, 'That Minecraft version was not part of the last version check.');
    res.json({
      ok: true,
      version: entry,
      unknown: state.report.unknown,
      unchecked: state.report.unchecked || [],
      partial: state.report.partial,
    });
  })
);

router.post(
  '/servers/:id/compat/scan',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const state = await compat.startScan(req.params.id, { actor: req.user.username });
    res.status(202).json({ ok: true, ...compatSummary(state) });
  })
);

// ---- Modpack manual-download resolver ----
// A CurseForge pack can pin mods that can't be auto-downloaded; itzg writes
// MODS_NEED_DOWNLOAD.txt and the install fails. These endpoints turn that into
// one-click Exclude / Modrinth-install / manual-jar upload.
const modUpload = multer({ dest: dataPath('tmp'), limits: { fileSize: 250 * 1024 * 1024, files: 1 } });

router.get(
  '/servers/:id/pending-downloads',
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    res.json({ ok: true, mods: mods.pendingDownloads(req.params.id) });
  })
);

router.post(
  '/servers/:id/pending-downloads/exclude',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const { filename } = z.object({ filename: z.string().min(1).max(300) }).parse(req.body);
    const token = mods.pendingExcludeToken(req.params.id, filename);
    mods.excludePackMod(req.params.id, token, { actor: req.user.username });
    mods.clearPendingLine(req.params.id, filename);
    res.json({ ok: true, excluded: token, mods: mods.pendingDownloads(req.params.id) });
  })
);

router.post(
  '/servers/:id/mods/upload',
  requireCap('content'),
  modUpload.single('file'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    if (!req.file) throw Object.assign(new Error('No file uploaded.'), { status: 400 });
    const excludeFilename = (req.body && req.body.excludeFilename) || null;
    const excludeToken = excludeFilename ? mods.pendingExcludeToken(req.params.id, excludeFilename) : null;
    try {
      const actor = req.user.username;
      const result = await tasks.track(`Importing ${req.file.originalname}…`, { serverId: req.params.id, actor }, () =>
        mods.importUploadedMod(req.params.id, req.file.path, req.file.originalname, { excludeToken, actor })
      );
      if (excludeFilename) mods.clearPendingLine(req.params.id, excludeFilename);
      res.status(201).json({ ok: true, ...result, mods: mods.pendingDownloads(req.params.id) });
    } finally {
      fs.promises.rm(req.file.path, { force: true }).catch((e) => {
        logger.debug('Could not remove a temporary upload file.', {
          err: serializeError(e, { includeStack: false }),
        });
      });
    }
  })
);

// ---- Mod-zip importer ----
// One upload, two shapes, auto-detected: a CurseForge modpack export
// (manifest.json of pinned {projectID, fileID} pairs + overrides/) or a
// hand-assembled zip of jars. Two-phase like blueprints: preview (non-mutating,
// returns an uploadToken) → import (runs as a task with per-mod progress).
const contentZip = require('../../../services/contentZip');
const zipImportBodySchema = z.object({
  uploadToken: zipTokenSchema,
  // pack zips select by fileId (number), jar zips by entry name (string)
  selections: z
    .array(z.union([z.coerce.number(), z.string().max(300)]))
    .max(1500)
    .optional(),
  applyOverrides: z.coerce.boolean().optional(),
});

router.post(
  '/servers/:id/mods/import-zip/preview',
  requireCap('content'),
  zipImportUpload.single('file'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    if (!req.file) throw Object.assign(new Error('No file uploaded.'), { status: 400 });
    let preview;
    try {
      preview = await contentZip.previewForServer(req.params.id, req.file.path);
    } catch (err) {
      await fsp.rm(req.file.path, { force: true }).catch(() => {});
      throw err;
    }
    res.json({ ok: true, preview, uploadToken: req.file.filename });
  })
);

router.post(
  '/servers/:id/mods/import-zip',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const server = requireServer(req.params.id);
    const input = zipImportBodySchema.parse(req.body);
    const zipPath = dataPath('tmp', input.uploadToken);
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ ok: false, error: 'The uploaded zip expired. Upload it again.' });
    }
    const actor = req.user.username;
    const taskId = tasks.run(
      `Importing mod zip into ${server.display_name}…`,
      { actor, serverId: server.id },
      async (t) => {
        try {
          return await contentZip.importForServer(server.id, zipPath, {
            selections: input.selections || null,
            applyOverrides: Boolean(input.applyOverrides),
            actor,
            onStep: (s) => t.step(s),
          });
        } finally {
          await fsp.rm(zipPath, { force: true }).catch(() => {});
        }
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

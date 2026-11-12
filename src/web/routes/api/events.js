'use strict';

// History export and retention, archived and full game logs.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const permissions = require('../../../services/permissions');
const eventsService = require('../../../events');
const { dataPath } = require('../../../storage/pathGuard');
const logger = require('../../../logger')('api');
const { serializeError } = require('../../../utils/logSanitize');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const { requireCap } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer } = require('./shared');

// ---- Events: export, excerpts, retention ----

function sendEventExport(req, res, serverId) {
  const { filename, contentType, body } = eventsService.exportEvents(serverId, {
    format: req.query.format,
    q: String(req.query.q || '').trim(),
    type: String(req.query.type || '').trim(),
    forUser: req.user,
  });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type(contentType).send(body);
}

// Export builds the whole body in memory and (server-scoped) is a heavier read
// than a plain list - gate it to write-capable roles rather than leaving it open
// to viewers via the method-based requireWrite.
router.get(
  '/events/export',
  requireRoleKeys('admin', 'operator'),
  require('../../middleware/auth').rejectCrossSiteGet,
  asyncHandler((req, res, next) => {
    sendEventExport(req, res, String(req.query.server || '') || null);
  })
);

router.get(
  '/servers/:id/events/export',
  requireCap('files'),
  require('../../middleware/auth').rejectCrossSiteGet,
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    sendEventExport(req, res, req.params.id);
  })
);

// Captured log excerpt for one event (text/plain; 404 when none was captured).
router.get(
  '/events/:id/excerpt',
  asyncHandler(async (req, res, next) => {
    const event = eventsService.getEvent(Number(req.params.id));
    if (!event || (event.server_id && !permissions.can(req.user, event.server_id, 'view'))) {
      throw Object.assign(new Error('Event not found.'), { status: 404 });
    }
    const text = await eventsService.readExcerpt(event);
    if (text == null) throw Object.assign(new Error('No captured log for this event.'), { status: 404 });
    res.type('text/plain').send(text);
  })
);

// Prune event history older than N days (excerpts included). The prune is a
// global delete (not server-scoped) so it needs the same admin-only gate as
// the retention config that would normally trigger it.
router.post(
  '/events/prune',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650) }).parse(req.body);
    const { removed } = await eventsService.pruneEvents(days, { actor: req.user.username });
    res.json({ ok: true, removed });
  })
);

// ---- Archived per-server logs (data/logs/<id>/events) ----

// Archived per-event log excerpts, written only by the panel (events/index.js)
// as `${Date.now()}-${type}-${nanoid(4)}.log`. The regex is defense-in-depth on
// top of safeJoin's containment check - require the .log suffix the panel uses
// and keep the character class tight (word chars, dots, parens/brackets, dashes)
// while excluding whitespace and anything a path separator could hide behind.
const archivedFileSchema = z.string().regex(/^[\w.,()[\]-]+\.log$/, 'Invalid archived log name.');

router.get(
  '/servers/:id/logs/archived',
  requireCap('files'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const dir = dataPath('logs', req.params.id, 'events');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (!st) continue;
      files.push({ file: e.name, size: st.size, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.json({ ok: true, files });
  })
);

router.get(
  '/servers/:id/logs/archived/:file',
  requireCap('files'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const file = archivedFileSchema.parse(req.params.file);
    const abs = dataPath('logs', req.params.id, 'events', file);
    if (!fs.existsSync(abs)) throw Object.assign(new Error('Archived log not found.'), { status: 404 });
    res.download(abs, file);
  })
);

// ---- Full game logs (the server's own logs/ dir on the bind mount) ----
// The /logs endpoint above is a small in-memory docker tail (capped 2000 lines);
// these serve the complete files Minecraft itself rotates: logs/latest.log and
// the gzipped history next to it.
const gameLogFileSchema = z.string().regex(/^[\w.-]+\.log(\.gz)?$/, 'Invalid log file name.');

async function listGameLogs(serverId) {
  const dir = dataPath('servers', serverId, 'logs');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.log(\.gz)?$/.test(e.name)) continue;
    const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
    if (st) out.push({ file: e.name, size: st.size, mtimeMs: st.mtimeMs });
  }
  // latest.log first, then newest-rotated first.
  out.sort((a, b) => (a.file === 'latest.log' ? -1 : b.file === 'latest.log' ? 1 : b.mtimeMs - a.mtimeMs));
  return out;
}

router.get(
  '/servers/:id/logs/game',
  requireCap('files'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    res.json({ ok: true, files: await listGameLogs(req.params.id) });
  })
);

router.get(
  '/servers/:id/logs/game/:file',
  requireCap('files'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const file = gameLogFileSchema.parse(req.params.file);
    const abs = dataPath('servers', req.params.id, 'logs', file);
    if (!fs.existsSync(abs)) throw Object.assign(new Error('Log file not found.'), { status: 404 });
    res.download(abs, file);
  })
);

// Every log file for the server, zipped on the fly. Bounded so a pathological
// logs/ dir can't stream forever.
const LOG_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
router.get(
  '/servers/:id/logs/bundle.zip',
  requireCap('files'),
  asyncHandler(async (req, res, next) => {
    const server = requireServer(req.params.id);
    const dir = dataPath('servers', req.params.id, 'logs');
    const list = await listGameLogs(req.params.id);
    if (!list.length) throw Object.assign(new Error('This server has no log files yet.'), { status: 404 });
    const total = list.reduce((n, f) => n + f.size, 0);
    if (total > LOG_BUNDLE_MAX_BYTES) {
      throw Object.assign(new Error('The log folder is too large to bundle. Download individual files instead.'), {
        status: 413,
      });
    }
    const { ZipArchive } = require('archiver');
    const safeName = String(server.display_name || req.params.id).replace(/[^\w.-]+/g, '_');
    res.attachment(`${safeName}-logs.zip`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', (err) => {
      logger.error('Log bundle stream failed.', { serverId: req.params.id, err: serializeError(err) });
      if (res.headersSent) return res.destroy();
      res.status(500).end();
    });
    zip.pipe(res);
    for (const f of list) zip.file(path.join(dir, f.file), { name: f.file });
    zip.finalize();
  })
);

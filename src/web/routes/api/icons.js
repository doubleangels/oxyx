'use strict';

// Custom server icons: upload and serving.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const { z } = require('zod');
const db = require('../../../db');
const eventsService = require('../../../events');
const { dataPath } = require('../../../storage/pathGuard');
const crypto = require('node:crypto');
const { matchesImageType, imageDimensions } = require('../../../utils/sniffImage');
const { sanitizeSvg } = require('../../../utils/svgSanitize');
const logger = require('../../../logger')('api');
const { serializeError } = require('../../../utils/logSanitize');
const { requireCap } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer } = require('./shared');

// ---- Custom server icon upload + serving ----

const ICON_MAX_BYTES = 16 * 1024 * 1024;
const ICON_EXTS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
const MAX_ICON_DIMENSION = 8192;
const iconUpload = multer({ dest: dataPath('tmp'), limits: { fileSize: ICON_MAX_BYTES, files: 1 } });

// multipart field: 'icon'. Stores data/library/icons/custom/<serverId><ext>
// and sets servers.icon = 'custom:<filename>' (render via /api/icons/custom/<file>).
router.post('/servers/:id/icon', requireCap('settings'), iconUpload.single('icon'), async (req, res, next) => {
  let consumed = false;
  try {
    const server = requireServer(req.params.id);
    if (!req.file) throw Object.assign(new Error('Attach an image (field "icon")'), { status: 400 });
    const ext = ICON_EXTS[req.file.mimetype];
    if (!ext) {
      throw Object.assign(new Error('Icons must be PNG, JPEG, WebP, or SVG (max 16 MB).'), { status: 400 });
    }
    if (!(await matchesImageType(req.file.path, req.file.mimetype))) {
      throw Object.assign(new Error("File contents don't match the declared image type"), { status: 400 });
    }
    if (req.file.mimetype === 'image/svg+xml') {
      const clean = sanitizeSvg(await fsp.readFile(req.file.path, 'utf8'));
      if (!/<svg[\s>]/i.test(clean)) {
        throw Object.assign(new Error('That SVG could not be processed safely.'), { status: 400 });
      }
      await fsp.writeFile(req.file.path, clean, 'utf8');
    } else {
      const dims = await imageDimensions(req.file.path, req.file.mimetype);
      if (dims && (dims.width > MAX_ICON_DIMENSION || dims.height > MAX_ICON_DIMENSION)) {
        throw Object.assign(
          new Error(`Image is too large in pixels (max ${MAX_ICON_DIMENSION}x${MAX_ICON_DIMENSION})`),
          { status: 400 }
        );
      }
    }
    const filename = `${server.id}${ext}`;
    const destDir = dataPath('library', 'icons', 'custom');
    await fsp.mkdir(destDir, { recursive: true });
    // Swap the new file in via a single rename off a sibling temp name (atomic
    // on the destination fs) - never rm-then-rename, which leaves a window where
    // a concurrent GET 404s or reads a half-written file.
    const stagePath = path.join(destDir, `.tmp-${server.id}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    await fsp.rename(req.file.path, stagePath).catch(async () => {
      await fsp.copyFile(req.file.path, stagePath);
      await fsp.rm(req.file.path, { force: true });
    });
    await fsp.rename(stagePath, path.join(destDir, filename)).catch(async (e) => {
      await fsp.rm(stagePath, { force: true }).catch(() => {});
      throw e;
    });
    consumed = true;
    // Retire stale variants with a different extension (new file already in place).
    for (const other of Object.values(ICON_EXTS)) {
      if (other !== ext) {
        await fsp.rm(path.join(destDir, `${server.id}${other}`), { force: true }).catch((e) => {
          logger.debug('Could not remove a stale server icon variant.', {
            serverId: server.id,
            err: serializeError(e, { includeStack: false }),
          });
        });
      }
    }
    db.run('UPDATE servers SET icon = ? WHERE id = ?', `custom:${filename}`, server.id);
    eventsService.recordEvent({
      serverId: server.id,
      actor: req.user.username,
      type: 'config-changed',
      summary: 'Custom server icon uploaded.',
    });
    logger.info('Uploaded a custom server icon.', { serverId: server.id, actor: req.user.username });
    res.json({ ok: true, icon: `custom:${filename}`, url: `/api/icons/custom/${filename}` });
  } catch (err) {
    if (req.file && !consumed) {
      await fsp.rm(req.file.path, { force: true }).catch((e) => {
        logger.debug('Could not remove a temporary upload file.', {
          err: serializeError(e, { includeStack: false }),
        });
      });
    }
    next(err);
  }
});

router.get(
  '/icons/custom/:file',
  asyncHandler((req, res, next) => {
    const file = z
      .string()
      .regex(/^srv_[\w-]+\.(png|svg|jpg|webp)$/, 'Invalid icon file.')
      .parse(req.params.file);
    const abs = dataPath('library', 'icons', 'custom', file);
    if (!fs.existsSync(abs)) throw Object.assign(new Error('Icon not found.'), { status: 404 });
    // Custom icons may be user-uploaded SVGs (not sanitized). Serve them under a
    // locked-down, sandboxed CSP so a <script> embedded in the SVG can't execute
    // if the file is opened directly, and block content-type sniffing.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  })
);

// Uploaded profile pictures (web/routes/account.js handles the upload itself,
// self-service). Not scoped to req.user - any authenticated user may view any
// other user's avatar image, same openness as the server-icon route above.
router.get(
  '/avatars/custom/:file',
  asyncHandler((req, res, next) => {
    const file = z
      .string()
      .regex(/^usr_[\w-]+\.(png|svg|jpg|webp)$/, 'Invalid avatar file.')
      .parse(req.params.file);
    const abs = dataPath('library', 'icons', 'users', file);
    if (!fs.existsSync(abs)) throw Object.assign(new Error('Avatar not found.'), { status: 404 });
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  })
);

// Mod/plugin/datapack platform icons are cached locally by library.cacheIcon()
// under data/library/icons/ and served by the authenticated /library/icons
// static mount in app.js (with the same sandbox CSP this route used to set,
// so a registry-supplied .svg still cannot run script). listContent emits the
// icon URL from icon_rel_path.

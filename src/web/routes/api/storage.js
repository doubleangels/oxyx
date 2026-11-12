'use strict';

// Storage: index scans and cleanup.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const tasks = require('../../../services/tasks');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const router = require('./router');

// ---- Storage ----
const indexer = require('../../../storage/indexer');
const storageCleanup = require('../storageCleanup');

router.post(
  '/storage/scan',
  asyncHandler(async (req, res, next) => {
    res.json({
      ok: true,
      ...(await tasks.track('Rescanning storage…', { actor: req.user.username }, () => indexer.scan())),
    });
  })
);

// Largest files: a bounded filesystem walk, so it runs from an admin-only GET
// the Storage page fires after render instead of blocking every page load (it
// used to run four cleanup dry-runs PLUS this scan on each load).
router.get(
  '/storage/largest-files',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res) => {
    const files = (await storageCleanup.largestFiles({ top: 15, maxScan: 3000 }).catch(() => [])).map((f) => ({
      ...f,
      link: `/files?path=${encodeURIComponent(f.path.split('/').slice(0, -1).join('/'))}`,
    }));
    res.json({ ok: true, files });
  })
);

// One-click cleanup. dryRun:true previews (nothing deleted) - the Storage
// page uses it to show real numbers before the confirm dialog.
router.post(
  '/storage/cleanup',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    const { action, olderThanDays, dryRun } = z
      .object({
        action: z.enum(['tmp', 'orphans', 'old-logs', 'old-crashes']),
        olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
        dryRun: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    const run = async () => {
      const result = await storageCleanup.runCleanup(action, {
        olderThanDays,
        dryRun: Boolean(dryRun),
        actor: req.user.username,
      });
      // The Storage page reloads as soon as this answers: rescan first so it
      // shows the freed space, not the totals from before the cleanup (a failed
      // scan is logged by the indexer and never fails the cleanup).
      if (!dryRun && result.removed > 0) await indexer.rescanNow();
      return result;
    };
    // A preview is a quick read; only a real cleanup shows in the task tray.
    const result = dryRun ? await run() : await tasks.track('Cleaning up storage…', { actor: req.user.username }, run);
    res.json({ ok: true, dryRun: Boolean(dryRun), ...result });
  })
);

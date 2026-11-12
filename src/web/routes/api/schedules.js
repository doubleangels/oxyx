// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Scheduled tasks.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const db = require('../../../db');
const permissions = require('../../../services/permissions');
const httpError = require('../../../utils/httpError');
const logger = require('../../../logger')('api');
const settingsService = require('../../../services/settings');
const router = require('./router');

// ---- Schedules ----
const scheduler = require('../../../services/scheduler');

// Validate a cron expression and preview the next 3 runs.
router.get('/schedules/preview', (req, res) => {
  const expr = String(req.query.cron || '').trim();
  try {
    if (!expr) throw new Error('Empty expression');
    const { Cron } = require('croner');
    const runs = new Cron(expr, { timezone: settingsService.getTimezone() }).nextRuns(3).map((d) => d.toISOString());
    res.json({ ok: true, cron: expr, runs });
  } catch (err) {
    logger.debug('Rejected an invalid cron expression.', { cron: expr, reason: err.message });
    res.status(400).json({ ok: false, error: `Invalid cron expression: ${err.message}` });
  }
});

// A server-scoped schedule runs an action on that server, so creating,
// toggling, or deleting one needs the capability that action needs.
const TASK_TYPE_KEYS = /** @type {[string, ...string[]]} */ (Object.keys(scheduler.TASK_TYPES));
function requireScheduleAccess(req, serverId, taskType) {
  const meta = scheduler.TASK_TYPES[taskType];
  if (!meta) throw httpError(400, 'Unknown task type.');
  if (meta.adminOnly && req.user.role !== 'admin') {
    // Fleet tasks (back up / restart every server) outrun any per-server grant.
    throw httpError(403, 'Only an admin can schedule a task that acts on every server.');
  }
  if (!meta.serverScoped) {
    // Panel-global work (storage scan, update check, temp cleanup, …) runs
    // against the whole panel whatever serverId is attached, so it follows the
    // global role: a viewer never reaches it, even with per-server grants.
    if (req.user.role === 'viewer') throw httpError(403, 'Your role (Viewer) is read-only.');
    return;
  }
  if (!serverId) return;
  const cap = meta.capability;
  const perms = permissions.effective(req.user, serverId);
  if (!perms.includes('view')) throw httpError(404, 'Server not found.');
  if (!perms.includes(cap)) {
    const label = permissions.CAPABILITY_INFO[cap].label.toLowerCase();
    throw httpError(403, `You don't have the ${label} permission on this server.`);
  }
}

router.post(
  '/schedules',
  asyncHandler((req, res, next) => {
    const input = z
      .object({
        serverId: z.string().trim().max(40).nullable().optional(),
        taskType: z.enum(TASK_TYPE_KEYS),
        cron: z.string().trim().min(5).max(60),
        payload: z.record(z.string(), z.any()).optional(),
        enabled: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    requireScheduleAccess(req, input.serverId || null, input.taskType);
    const scoped = scheduler.TASK_TYPES[input.taskType] && scheduler.TASK_TYPES[input.taskType].serverScoped;
    res.status(201).json({
      ok: true,
      schedule: scheduler.createSchedule(
        {
          serverId: scoped ? input.serverId || null : null,
          taskType: input.taskType,
          cron: input.cron,
          payload: input.payload,
          enabled: input.enabled !== false,
        },
        { actor: req.user.username }
      ),
    });
  })
);

router.post(
  '/schedules/:id/toggle',
  asyncHandler((req, res, next) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const job = db.get('SELECT server_id, task_type FROM schedules WHERE id = ?', req.params.id);
    if (job) requireScheduleAccess(req, job.server_id, job.task_type);
    scheduler.setEnabled(req.params.id, enabled, { actor: req.user.username });
    res.json({ ok: true });
  })
);

// Run a schedule's task now (202: it continues in the background and in the task tray).
router.post(
  '/schedules/:id/run',
  asyncHandler((req, res, next) => {
    const job = db.get('SELECT server_id, task_type FROM schedules WHERE id = ?', req.params.id);
    if (!job) throw httpError(404, 'Schedule not found.');
    requireScheduleAccess(req, job.server_id, job.task_type);
    scheduler.runNow(req.params.id, { actor: req.user.username });
    res.status(202).json({ ok: true });
  })
);

router.delete(
  '/schedules/:id',
  asyncHandler((req, res, next) => {
    const job = db.get('SELECT server_id, task_type FROM schedules WHERE id = ?', req.params.id);
    if (job) requireScheduleAccess(req, job.server_id, job.task_type);
    scheduler.deleteSchedule(req.params.id, { actor: req.user.username });
    res.json({ ok: true });
  })
);

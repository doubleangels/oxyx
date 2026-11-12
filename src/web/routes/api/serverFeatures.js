// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Per-server feature mounts (blueprints, worlds, files, crashes, players, integrations, analytics, inventory, items) plus world quick controls, world shrink, admin chat and the live map.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const servers = require('../../../services/servers');
const tasks = require('../../../services/tasks');
const logger = require('../../../logger')('api');
const { serializeError } = require('../../../utils/logSanitize');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const { requireCap, requireCapForWrites } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer } = require('./shared');

// ---- Blueprints ----
router.use('/blueprints', require('../blueprints'));

// ---- World quick controls (Overview tab) - version-tolerant service ----
const worldControls = require('../../../services/worldControls');

const WORLD_STATE_LIVE_STATUSES = new Set(['running', 'unhealthy', 'stalled']);

router.get(
  '/servers/:id/world/state',
  asyncHandler(async (req, res, next) => {
    const server = requireServer(req.params.id);
    // ?rules=a,b,c limits the gamerule reads to what the page is showing;
    // ?all=1 forces the full set.
    const all = req.query.all === '1' || req.query.all === 'true';
    const rules = all
      ? undefined
      : String(req.query.rules || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    const asked = rules && rules.length ? rules : null;
    // An explicit but empty ?rules= means the page has no chips on screen -
    // answer without a single read rather than treating "nothing" as "everything".
    if (!all && req.query.rules !== undefined && rules && rules.length === 0) {
      return res.json({ ok: true, running: WORLD_STATE_LIVE_STATUSES.has(server.status), degraded: false, state: {} });
    }

    // Stopped/crashed: read the last-saved values straight from level.dat so the
    // rail still shows the world clock and gamerule states (read-only - the
    // <fieldset> is disabled offline). starting/updating: the world may be mid
    // (re)generation, so report "not available yet".
    if (!WORLD_STATE_LIVE_STATUSES.has(server.status)) {
      if (server.status === 'starting' || server.status === 'updating') {
        return res.json({ ok: true, running: false, state: {} });
      }
      const { state, unsupported } = splitUnsupported(await worldControls.getStateOffline(req.params.id, { rules }));
      const degraded = asked ? asked.some((r) => !Object.hasOwn(state, r) && !unsupported.includes(r)) : false;
      return res.json({ ok: true, running: false, offline: true, degraded, unsupported, state });
    }

    try {
      const { state, unsupported } = splitUnsupported(await worldControls.getState(req.params.id, { rules }));
      // Flag a partial read so the page can say "some settings couldn't be read"
      // rather than showing stale chips as if they were current. A rule this
      // Minecraft version does not have is not a partial read.
      const degraded = asked ? asked.some((r) => !Object.hasOwn(state, r) && !unsupported.includes(r)) : false;
      res.json({ ok: true, running: true, degraded, unsupported, state });
    } catch (err) {
      // The status says running but RCON isn't answering (just-booted, wedged).
      // Fall back to the on-disk values rather than showing nothing.
      logger.info('Could not read live world state; falling back to level.dat.', {
        serverId: req.params.id,
        err: serializeError(err, { includeStack: false }),
      });
      const { state, unsupported } = splitUnsupported(await worldControls.getStateOffline(req.params.id, { rules }));
      const degraded = asked ? asked.some((r) => !Object.hasOwn(state, r) && !unsupported.includes(r)) : false;
      res.json({ ok: true, running: false, offline: true, degraded, unsupported, state });
    }
  })
);

/** Pull the service's `unsupported` list out of the state object it rides on. */
function splitUnsupported(full) {
  const { unsupported = [], ...state } = full || {};
  return { state, unsupported };
}

router.post(
  '/servers/:id/world/quick',
  requireCap('console'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const { action } = z.object({ action: z.enum(Object.keys(worldControls.QUICK_ACTIONS)) }).parse(req.body);
    const result = await worldControls.runQuick(req.params.id, action, { actor: req.user.username });
    res.json({ ok: true, ...result });
  })
);

// ---- Shrink world (remove rarely-visited chunks) ----
// dryRun:true previews the numbers synchronously (the modal shows them before
// the confirm); a real run is a task (it can touch thousands of region files).
// Server must be stopped - worldShrink.shrinkWorld enforces that with a 409.
const worldShrink = require('../../../services/worldShrink');
const SHRINK_LIVE_STATUSES = new Set(['running', 'starting', 'unhealthy', 'stalled', 'updating']);
router.post(
  '/servers/:id/worlds/:world/shrink',
  requireCap('content'),
  asyncHandler(async (req, res, next) => {
    const server = requireServer(req.params.id);
    const src = { ...req.query, ...req.body };
    const { world, dryRun, minInhabitedTicks, spawnKeepChunks, autoStopStart } = z
      .object({
        world: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9 _.-]{1,64}$/),
        dryRun: z.coerce.boolean().default(false),
        // "rarely visited" threshold in ticks (20 = 1 s), 1 tick .. 1 game-hour.
        minInhabitedTicks: z.coerce
          .number()
          .int()
          .min(1)
          .max(20 * 60 * 60)
          .optional(),
        // keep overworld chunks within N of the origin; 0 disables spawn protection.
        spawnKeepChunks: z.coerce.number().int().min(0).max(256).optional(),
        // when the server is up: stop it, shrink, then start it again.
        autoStopStart: z.coerce.boolean().default(false),
      })
      .parse({ world: req.params.world, ...src });
    const actor = req.user.username;
    const shrinkOpts = { worldName: world, actor, minInhabitedTicks, spawnKeepChunks };

    if (dryRun) {
      const result = await worldShrink.shrinkWorld(server.id, { ...shrinkOpts, dryRun: true });
      return res.json({ ok: true, ...result });
    }

    const isLive = SHRINK_LIVE_STATUSES.has(server.status);
    if (isLive && !autoStopStart) {
      // Same 409 the service would throw, but decided here so the client can
      // offer the stop/start wrapper instead.
      throw Object.assign(
        new Error('Stop the server before shrinking its world, or choose the stop-and-restart option.'),
        { status: 409 }
      );
    }

    const taskId = tasks.run(
      `Shrinking "${world}" on ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        // Decide from the CONTAINER's current state, not the DB row above (which
        // is only refreshed by the 60s status poll and can be stale right after a
        // start/stop). A stale "stopped" here would corrupt: shrink would run
        // while the JVM is actually writing region files.
        let wasRunning = false;
        if (autoStopStart && (await worldShrink.isLive(server.id))) {
          wasRunning = true;
          t.step('Stopping the server…');
          await servers.stopServer(server.id, { actor });
        }
        t.step('Scanning region files for rarely-visited chunks…');
        let result;
        try {
          result = await worldShrink.shrinkWorld(server.id, shrinkOpts);
        } finally {
          // The user asked for a stop-shrink-start round trip: bring the server
          // back even when the shrink itself failed, never leave it down.
          if (wasRunning) {
            t.step('Starting the server back up…');
            await servers.startServer(server.id, { actor });
          }
        }
        return { ...result, restarted: wasRunning };
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

// ---- Admin chat (tellraw / say over RCON) ----
const chat = require('../../../services/chat');

router.post(
  '/servers/:id/chat',
  requireCap('console'),
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const body = z
      .object({
        mode: z.enum(['tellraw', 'say']).default('tellraw'),
        target: z.string().trim().max(32).default('@a'),
        text: z.string().min(1).max(512),
        color: z.string().trim().max(20).optional(),
        bold: z.coerce.boolean().optional(),
        italic: z.coerce.boolean().optional(),
        underlined: z.coerce.boolean().optional(),
        strikethrough: z.coerce.boolean().optional(),
        obfuscated: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    const result = await chat.sendChat(req.params.id, { ...body, actor: req.user.username });
    res.status(201).json({ ok: true, ...result });
  })
);

// ---- Live map (BlueMap) ----
const mapService = require('../../../services/map');

router.post(
  '/servers/:id/map/enable',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    const actor = req.user.username;
    res.json({
      ok: true,
      ...(await tasks.track('Enabling the live map…', { serverId: req.params.id, actor }, () =>
        mapService.enableMap(req.params.id, { actor })
      )),
    });
  })
);

router.post(
  '/servers/:id/map/disable',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    await mapService.disableMap(req.params.id, { actor: req.user.username });
    res.json({ ok: true });
  })
);

// ---- Worlds & files ----
router.use('/worlds', require('../worlds'));
router.use('/servers/:id/worlds', requireCapForWrites('content'), require('../worlds').serverWorlds);
// `files` capability for the whole tree, reads included: server.properties
// carries the plaintext rcon.password, so a `view`-only user is kept out
// rather than relying on requireWrite, which only blocks their non-GET requests.
router.use('/servers/:id/files', requireCap('files'), require('../files').serverFiles);
router.use('/files', require('../../middleware/auth').requireRole('admin'), require('../files').globalFiles);

// ---- Crash reports ----
router.use('/servers/:id/crashes', requireCapForWrites('files'), require('../crashes'));

// ---- Player god-mode ----
router.use('/servers/:id/players', requireCapForWrites('players'), require('../players'));

// ---- Custom chat commands (!rtp2 …) ----
router.use('/servers/:id/chat-commands', requireCapForWrites('console'), require('../chatCommands'));

// ---- Integrations (Discord, invites, status page) ----
router.use('/servers/:id/integrations', requireCapForWrites('settings'), require('../integrations'));

// ---- Conversational chatbot (legacy /wizard API; configuration + transcripts are admin-only) ----
router.use('/servers/:id/wizard', requireRoleKeys('admin'), require('../wizard'));

// ---- Analytics & activity timeline ----
router.use('/servers/:id/analytics', requireCapForWrites('players'), require('../analytics'));

// ---- Inventory forensics ----
router.use('/servers/:id/inventory', requireCapForWrites('content'), require('../inventory'));
router.use('/inventory', require('../inventory').globalSearch);

// ---- Item registry (JEI-style browser, built from the server's own jars) ----
router.use('/servers/:id/items', requireCapForWrites('content'), require('../items'));

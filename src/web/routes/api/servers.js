// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Servers: create, settings, power, live status, alerts, Docker health.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const servers = require('../../../services/servers');
const ports = require('../../../services/ports');
const mojang = require('../../../services/mojang');
const tasks = require('../../../services/tasks');
const permissions = require('../../../services/permissions');
const httpError = require('../../../utils/httpError');
const healthAlerts = require('../../../services/healthAlerts');
const { checkDocker } = require('../../../docker/connect');
const { fetchLogs } = require('../../../docker/logs');
const { statsOnce } = require('../../../docker/stats');
const dockerNetworks = require('../../../docker/networks');
const dockerSpec = require('../../../services/dockerSpec');
const { dockerOverridesSchema, requireAdminForOverrides } = require('../dockerOverridesSchema');
const router = require('./router');
const { SERVER_TYPES, requireServer, optNum0, publicServer } = require('./shared');

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(16).optional(),
    type: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine((v) => SERVER_TYPES.includes(v), { message: 'Unknown server type.' }),
    mcVersion: z.string().trim().max(32).optional(),
    javaTag: z.string().max(16).optional(),
    env: z.record(z.string(), z.string()).optional(),
    portGame: z.coerce.number().int().min(1024).max(65535).optional(),
    portRcon: z.coerce.number().int().min(1024).max(65535).optional(),
    portBedrock: z.coerce.number().int().min(1024).max(65535).optional(),
    withBedrock: z.coerce.boolean().optional(),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    cpus: optNum0(128),
    diskQuotaGb: optNum0(16384),
    updatePolicy: z.enum(['manual', 'notify', 'auto']).optional(),
    autoStart: z.coerce.boolean().optional(),
    start: z.coerce.boolean().optional(),
    ...dockerOverridesSchema,
  })
  .refine((v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb, {
    message:
      'Container memory limit must be higher than the Java heap, or the server will be stopped for running out of memory.',
  });

router.post(
  '/servers',
  asyncHandler(async (req, res, next) => {
    const input = createSchema.parse(req.body);
    requireAdminForOverrides(req, input);
    const actor = req.user.username;
    const server = await tasks.track(`Creating ${input.name}…`, { actor }, () =>
      servers.createServer(input, { actor, start: input.start !== false })
    );
    res.status(201).json({ ok: true, server: publicServer(server) });
  })
);

// Shared PATCH + changes-preview input. One schema so the "what will change"
// modal can never drift from what the PATCH accepts (a field accepted in the
// preview but rejected by the save would be a confusing promise).
const serverPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(16).optional(),
    notes: z.string().max(8000).optional(),
    mcVersion: z.string().trim().max(32).optional(),
    javaTag: z.string().max(16).optional(),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    cpus: optNum0(128),
    diskQuotaGb: optNum0(16384),
    quotaStrict: z.coerce.boolean().optional(),
    updatePolicy: z.enum(['manual', 'notify', 'auto']).optional(),
    autoStart: z.coerce.boolean().optional(),
    autoRestart: z.coerce.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    ...dockerOverridesSchema,
  })
  .refine((v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb, {
    message: 'Container memory limit must be higher than the Java heap.',
  });

// Per-server permissions: resolve once per request, hide unviewable servers,
// then every route below names the capability it needs (see docs/users-and-roles.md).
const { serverScope, requireCap } = require('../../middleware/serverAccess');
router.use('/servers/:id', serverScope);

const shutdownWarning = require('../../../services/shutdownWarning');
const POWER_TITLES = {
  start: 'Starting',
  stop: 'Stopping',
  restart: 'Restarting',
  kill: 'Force-stopping',
  recreate: 'Rebuilding',
};
for (const action of Object.keys(POWER_TITLES)) {
  router.post(
    `/servers/:id/${action}`,
    requireCap('power'),
    asyncHandler(async (req, res, next) => {
      const actor = req.user.username;
      const name = requireServer(req.params.id).display_name;
      // Restart and Stop can warn the players in game first. That countdown
      // runs for minutes, so the request answers at once (202 + taskId) and
      // the task tray follows it, instead of a request a proxy would time out.
      // Applying changes (recreate) restarts a running server too, so it warns the same way.
      const warnSeconds =
        action === 'restart' || action === 'stop' || action === 'recreate'
          ? z.coerce.number().int().min(0).max(shutdownWarning.MAX_WARN_SECONDS).catch(0).parse(req.body?.warnSeconds)
          : 0;
      if (warnSeconds > 0) {
        const taskId = tasks.run(`${POWER_TITLES[action]} ${name}…`, { serverId: req.params.id, actor }, async (t) => {
          const w = await shutdownWarning.warnBeforeShutdown(req.params.id, {
            action: action === 'stop' ? 'stop' : 'restart',
            seconds: warnSeconds,
            task: t,
          });
          if (w.cancelled) return { ok: true, skipped: true };
          t.step(`${POWER_TITLES[action]}…`);
          await servers[`${action}Server`](req.params.id, { actor });
          return { ok: true };
        });
        return res.status(202).json({ ok: true, taskId, warnSeconds });
      }
      await tasks.track(`${POWER_TITLES[action]} ${name}…`, { serverId: req.params.id, actor }, () =>
        servers[`${action}Server`](req.params.id, { actor })
      );
      res.json({ ok: true, server: publicServer(servers.getServer(req.params.id)) });
    })
  );
}

// Plugin-family gate (#53): changing mc_version on a Paper-family server to a
// loader-unsupported target is refused up front (cheap when untouched - the
// probe only fires when the version actually changes). Registry down → pass
// through, exactly like the upgrade route. Shared by the PATCH and the
// changes-preview so the confirmation modal can never confirm a save the PATCH
// would refuse.
async function assertPluginFamilyMcGate(before, mcVersion) {
  if (mcVersion !== before.mc_version && require('../../../services/mods').loaderOf(before) === 'paper') {
    const gate = await require('../../../services/loaderVersions').mcAvailableOnServerType(before.type, mcVersion, {
      channel: before.env.PAPER_CHANNEL || 'default',
    });
    if (!gate.supported) {
      const flavor = require('../../../web/viewModels').flavorLabel(before.type);
      throw httpError(
        409,
        `${flavor} has not published a Minecraft ${mcVersion} build yet. Switch this server to the experimental channel to track pre-releases, or pick a released version.`
      );
    }
  }
}

router.patch(
  '/servers/:id',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    const changes = serverPatchSchema.parse(req.body);
    requireAdminForOverrides(req, changes);
    if (changes.mcVersion) {
      await assertPluginFamilyMcGate(requireServer(req.params.id), changes.mcVersion);
    }
    if (
      changes.containerName !== undefined ||
      changes.networkName !== undefined ||
      changes.extraPorts !== undefined ||
      changes.extraBinds !== undefined
    ) {
      const before = requireServer(req.params.id);
      await dockerSpec.validateOverrides(
        {
          containerName: changes.containerName || null,
          networkName: changes.networkName || null,
          extraPorts: changes.extraPorts ?? before.extraPorts,
          extraBinds: changes.extraBinds ?? before.extraBinds,
        },
        { previousExtraPorts: before.extraPorts }
      );
    }
    const { server, needsRecreate } = servers.updateServer(req.params.id, changes, { actor: req.user.username });
    res.json({ ok: true, needsRecreate, server: publicServer(server) });
  })
);

// What the settings save-confirmation modal shows BEFORE the PATCH runs: the
// same diff, expanded per-key, without mutating anything. A POST so the
// method-based requireWrite gate keeps viewers out exactly like the PATCH.
router.post(
  '/servers/:id/changes-preview',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    const changes = serverPatchSchema.parse(req.body);
    requireAdminForOverrides(req, changes);
    if (changes.mcVersion) {
      await assertPluginFamilyMcGate(requireServer(req.params.id), changes.mcVersion);
    }
    if (
      changes.containerName !== undefined ||
      changes.networkName !== undefined ||
      changes.extraPorts !== undefined ||
      changes.extraBinds !== undefined
    ) {
      const before = requireServer(req.params.id);
      await dockerSpec.validateOverrides(
        {
          containerName: changes.containerName || null,
          networkName: changes.networkName || null,
          extraPorts: changes.extraPorts ?? before.extraPorts,
          extraBinds: changes.extraBinds ?? before.extraBinds,
        },
        { previousExtraPorts: before.extraPorts }
      );
    }
    const preview = servers.summarizeServerChanges(req.params.id, changes);
    res.json({ ok: true, ...preview });
  })
);

// Advanced Docker settings: host network discovery, and the "Preview as YAML"
// round trip shared by the wizard (pre-creation) and the Settings tab (post-creation).

router.get(
  '/docker/networks',
  require('../../middleware/auth').requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, networks: await dockerNetworks.listNetworks() });
  })
);

const previewSchema = z.object({
  type: z.string().trim().max(32).optional(),
  mcVersion: z.string().trim().max(32).optional(),
  javaTag: z.string().max(16).optional(),
  env: z.record(z.string(), z.string()).optional(),
  heapMb: z.coerce.number().int().min(512).max(262144).optional(),
  containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
  containerSwapMb: z.coerce.number().int().min(0).optional(),
  cpus: optNum0(128),
  portGame: z.coerce.number().int().min(1024).max(65535).optional(),
  portRcon: z.coerce.number().int().min(1024).max(65535).optional(),
  portBedrock: z.coerce.number().int().min(1024).max(65535).optional(),
  withBedrock: z.coerce.boolean().optional(),
  ...dockerOverridesSchema,
});

router.post(
  '/docker/preview',
  require('../../middleware/auth').requireRole('admin'),
  asyncHandler((req, res) => {
    const input = previewSchema.parse(req.body);
    res.json({ ok: true, yaml: dockerSpec.toYaml(servers.previewCreateSpec(input)) });
  })
);

router.post(
  '/docker/preview/parse',
  require('../../middleware/auth').requireRole('admin'),
  asyncHandler((req, res) => {
    const { yaml: text } = z.object({ yaml: z.string().max(20000) }).parse(req.body);
    res.json({ ok: true, spec: dockerSpec.fromYaml(text) });
  })
);

router.get(
  '/servers/:id/docker-spec',
  require('../../middleware/auth').requireRole('admin'),
  asyncHandler((req, res) => {
    requireServer(req.params.id);
    res.json({ ok: true, yaml: dockerSpec.toYaml(servers.previewServerSpec(req.params.id)) });
  })
);

router.delete(
  '/servers/:id',
  requireCap('delete'),
  asyncHandler(async (req, res, next) => {
    // Deletion is opt-in: files + backups are KEPT by default, and only
    // removed when the caller explicitly asks via deleteFiles/deleteBackups.
    const actor = req.user.username;
    const { freedBytes } = await tasks.track(`Deleting ${requireServer(req.params.id).display_name}…`, { actor }, () =>
      servers.deleteServer(req.params.id, {
        actor,
        keepWorld: req.query.deleteFiles !== 'true' && req.query.keepFiles !== 'false',
        keepBackups: req.query.deleteBackups !== 'true' && req.query.keepBackups !== 'false',
      })
    );
    res.json({ ok: true, freedBytes });
  })
);

router.get(
  '/servers/:id/logs',
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    // fetchLogs buffers the whole tail (Buffer + demuxed string) in memory, so
    // cap it at 2000 lines here - the live WS console covers anything ongoing,
    // and this endpoint is just the "recent output" snapshot.
    const tail = Math.max(1, Math.min(Number(req.query.tail) || 500, 2000));
    res.type('text/plain; charset=utf-8').send(await fetchLogs(req.params.id, { tail }));
  })
);

// The console's custom quick buttons for one server, shared by every admin.
router.put(
  '/servers/:id/console-quick',
  requireCap('console'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const { commands } = z
      .object({
        commands: z
          .array(
            z.object({
              label: z.string().trim().min(1, 'Give the button a name.').max(32, 'Keep the name under 32 characters.'),
              command: z
                .string()
                .trim()
                .min(1, 'Enter the command to run.')
                .max(256, 'Keep the command under 256 characters.')
                .regex(/^[^\r\n]+$/, 'Use a single-line command.'),
            })
          )
          .max(20, 'A server can have up to 20 quick buttons.'),
      })
      .parse(req.body);
    const clean = commands.map((c) => ({ label: c.label, command: c.command.replace(/^\//, '') }));
    require('../../../services/settings').set(`console-quick:${req.params.id}`, clean);
    res.json({ ok: true, commands: clean });
  })
);

// Per-server label for panel-run console actions (announced in-game). Empty clears it.
router.put(
  '/servers/:id/console-label',
  requireCap('settings'),
  asyncHandler((req, res, next) => {
    requireServer(req.params.id);
    const { label } = z.object({ label: z.string().max(48).optional() }).parse(req.body);
    res.json({ ok: true, label: servers.setConsoleLabel(req.params.id, label) });
  })
);

router.get(
  '/servers/:id/stats',
  asyncHandler(async (req, res) => {
    requireServer(req.params.id);
    const live = require('../../../services/liveCache').get(req.params.id);
    // The brokered docker-stats stream keeps per-tick samples in memory while a
    // server runs, so a stats read is sub-millisecond instead of a ~2 s Docker
    // round trip. Only containers with no live feed (stopped, or cache not yet
    // attached) fall back to a one-shot statsOnce.
    if (live.stats) return res.json({ ok: true, stats: live.stats });
    res.json({ ok: true, stats: await statsOnce(req.params.id) });
  })
);

// Batched live data for client-side hydration (dashboard cards, headers).
// Includes the DB status for EVERY server so the dashboard can move the
// status dot when a server crashes or stops - hydration used to update only
// the numbers, leaving a crashed server pulsing green "Running" until reload.
router.get('/servers/live', (req, res) => {
  const liveCache = require('../../../services/liveCache');
  const db = require('../../../db');
  const all = liveCache.getAll();
  const out = {};
  const rows = permissions.filterVisible(
    req.user,
    db.all('SELECT id, status FROM servers WHERE deleted_at IS NULL'),
    permissions.visibleServerIds(req.user)
  );
  for (const row of rows) {
    const e = all[row.id] || {};
    out[row.id] = {
      status: row.status,
      cpuPct: e.stats ? e.stats.cpuPct : null,
      memUsedMb: e.stats ? Math.round(e.stats.memUsedBytes / 1024 / 1024) : null,
      players: e.players ? { online: e.players.online, max: e.players.max, names: e.players.names } : null,
      startedAt: e.startedAt || null,
      perf: e.perf || null,
      perfSupported: e.perfSupported !== false,
      // Shared with the SSR statusDetail (viewModels.js) so the label the page
      // rendered on load and the one this poll hydrates in can never disagree.
      phase: liveCache.statusDetail(e),
    };
  }
  res.json({ ok: true, servers: out });
});

// One place to answer "is anything wrong right now?" - for the operator and for
// an external monitor to poll. Read-only, cheap (cached status + one events
// query + one statfs), never touches Docker.
router.get(
  '/status/summary',
  asyncHandler(async (req, res, next) => {
    const db = require('../../../db');
    // Real status values only: a quota stop is surfaced via the 'quota-exceeded'
    // alert below, and nothing ever writes 'over-quota' to servers.status.
    const PROBLEM_STATUSES = new Set(['crashed', 'stalled', 'unhealthy']);
    // Keep in sync with the alert event types forwarded in integrations/discord.js.
    const ALERT_TYPES = [
      'oom',
      'port-change-failed',
      'auto-restart-gave-up',
      'unhealthy',
      'startup-stalled',
      'stop-failed',
      'schedule-failed',
      'quota-exceeded',
      'crash-loop',
      'crash-report',
      'offline-after-restart',
      'update-failed',
    ];

    // Alerts use the full visibility set (deleted servers included) so a
    // crash on a server removed since is still reported, as before. Built here
    // and shared with the row filter so the granted set is queried once.
    const visibleIds = permissions.visibleServerIds(req.user);
    const serverRows = permissions.filterVisible(
      req.user,
      db.all('SELECT id, display_name, status FROM servers WHERE deleted_at IS NULL ORDER BY created_at'),
      visibleIds
    );
    const problems = serverRows
      .filter((s) => PROBLEM_STATUSES.has(s.status))
      .map((s) => ({ serverId: s.id, server: s.display_name, kind: s.status }));

    const ph = ALERT_TYPES.map(() => '?').join(',');
    const recentAlerts = db
      .all(
        `SELECT e.type, e.summary, e.server_id, e.created_at, s.display_name AS server
           FROM events e LEFT JOIN servers s ON s.id = e.server_id
          WHERE e.type IN (${ph}) AND e.created_at > datetime('now', '-1 day')
          ORDER BY e.id DESC LIMIT 50`,
        ...ALERT_TYPES
      )
      .filter((r) => !r.server_id || visibleIds.has(r.server_id))
      .map((r) => ({ type: r.type, summary: r.summary, serverId: r.server_id, server: r.server, at: r.created_at }));

    const disk = await require('../../../storage/indexer')
      .diskFree()
      .then(({ free, total }) => ({
        freeBytes: free,
        totalBytes: total,
        freePct: total ? Math.round((free / total) * 100) : null,
      }))
      .catch(() => ({ freeBytes: null, totalBytes: null, freePct: null }));
    if (disk.freePct != null && disk.freePct < 5) {
      problems.push({ serverId: null, server: null, kind: 'disk-low', detail: `Only ${disk.freePct}% disk free.` });
    }

    res.json({
      ok: true,
      healthy: problems.length === 0,
      generatedAt: new Date().toISOString(),
      servers: serverRows.map((s) => ({ serverId: s.id, server: s.display_name, status: s.status })),
      problems,
      recentAlerts,
      disk,
    });
  })
);

// Changing an existing server's game port. Server-scoped twins of the
// /ports/* routes below: same checks, except the server's own live and pending
// ports count as free for it, and non-admins stay inside the game port range.
router.get(
  '/servers/:id/port/check',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    const port = Number(req.query.port);
    if (!Number.isInteger(port)) return res.status(400).json({ ok: false, error: 'A port number is required.' });
    const result = await ports.checkGamePort(port, {
      exceptServerId: req.params.id,
      isAdmin: req.user.role === 'admin',
    });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/servers/:id/port/suggest',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, ports: await ports.suggestPorts({ exceptServerId: req.params.id }) });
  })
);

router.put(
  '/servers/:id/port',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    // Range is the service's call (it differs by role and names the range in
    // its message); this only rejects a non-number.
    const { port, restart } = z
      .object({
        port: z.coerce.number().int(),
        restart: z
          .preprocess(
            (v) => (v === 'true' ? true : v === 'false' ? false : v),
            z.boolean({ message: 'Send restart as true or false.' })
          )
          .optional(),
      })
      .parse(req.body);
    const { server, changed, restarted } = await servers.changeGamePort(req.params.id, port, {
      actor: req.user.username,
      isAdmin: req.user.role === 'admin',
      restart: restart === true, // the person agreed to restart a running server
    });
    res.json({ ok: true, changed, restarted, server: publicServer(server) });
  })
);

// Dashboard health alerts (crashes, out-of-memory stops, auto-restarts): each
// user dismisses their own; the history events stay. See services/healthAlerts.js.
router.post('/alerts/clear', (req, res) => {
  res.json({ ok: true, cleared: healthAlerts.clearAll(req.user, permissions.visibleServerIds(req.user)) });
});

router.post('/alerts/:eventId/dismiss', (req, res) => {
  const eventId = z.coerce.number().int().positive().parse(req.params.eventId);
  healthAlerts.dismiss(req.user, permissions.visibleServerIds(req.user), eventId);
  res.json({ ok: true });
});

// Port picking for new servers: the roles that can create one. Answers name
// host ports in use, so viewers don't get them.
router.get(
  '/ports/check',
  require('../../middleware/auth').requireRole('admin', 'operator'),
  asyncHandler(async (req, res, next) => {
    const port = Number(req.query.port);
    if (!Number.isInteger(port)) return res.status(400).json({ ok: false, error: 'A port number is required.' });
    res.json({ ok: true, port, free: await ports.isPortFree(port) });
  })
);

router.get(
  '/ports/suggest',
  require('../../middleware/auth').requireRole('admin', 'operator'),
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, ports: await ports.suggestPorts({ withBedrock: req.query.bedrock === 'true' }) });
  })
);

router.get(
  '/versions',
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, versions: await mojang.listVersions({ includeSnapshots: req.query.snapshots === 'true' }) });
  })
);

router.get(
  '/docker/status',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, docker: await checkDocker() });
  })
);

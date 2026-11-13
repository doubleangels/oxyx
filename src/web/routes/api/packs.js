// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Modpacks (resolve, install pinned, upgrade, rollback) and the pack browser.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const servers = require('../../../services/servers');
const tasks = require('../../../services/tasks');
const db = require('../../../db');
const permissions = require('../../../services/permissions');
const httpError = require('../../../utils/httpError');
const { dockerOverridesSchema, requireAdminForOverrides } = require('../dockerOverridesSchema');
const mods = require('../../../services/mods');
const { requireCap } = require('../../middleware/serverAccess');
const router = require('./router');
const { requireServer, optNum0 } = require('./shared');

// ---- Modpacks: resolve/preview, install (always pinned), upgrade, rollback ----
const packs = require('../../../services/packs');
const upgrade = require('../../../updates/upgrade');
const checker = require('../../../updates/checker');
const backups = require('../../../services/backups');

router.post(
  '/packs/resolve',
  asyncHandler(async (req, res, next) => {
    const { platform, ref, versionId, mcVersion } = z
      .object({
        platform: z.enum(['curseforge', 'modrinth', 'ftb', 'gtnh']),
        ref: z.string().trim().min(1).max(400),
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        mcVersion: z.string().trim().max(32).optional(),
      })
      .parse(req.body);
    res.json({ ok: true, pack: await packs.resolvePack(platform, ref, { versionId, mcVersion }) });
  })
);

router.post(
  '/servers/:id/pack',
  requireCap('content'),
  asyncHandler(async (req, res) => {
    const { platform, ref, versionId, force } = z
      .object({
        platform: z.enum(['curseforge', 'modrinth', 'ftb', 'gtnh']),
        ref: z.string().trim().min(1).max(400),
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        force: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    try {
      const resolved = await tasks.track(
        'Applying a modpack…',
        { serverId: req.params.id, actor: req.user.username },
        async (t) => {
          t.step('Resolving the pack…');
          const r = await packs.resolvePack(platform, ref, { versionId });
          t.step('Pinning the pack version…');
          await packs.applyPack(req.params.id, r, { actor: req.user.username, force });
          return r;
        }
      );
      res.json({ ok: true, pack: resolved, note: 'Applied. Rebuild or restart the server to install.' });
    } catch (err) {
      if (err.requiresForce) {
        return res.status(409).json({ ok: false, error: err.message, requiresForce: true, warnings: err.warnings });
      }
      throw err;
    }
  })
);

const UPGRADE_STEP_LABELS = {
  resolving: 'Resolving target version…',
  'backing-up': 'Creating pre-update backup…',
  stopping: 'Stopping server…',
  applying: 'Re-pinning pack version…',
  recreating: 'Recreating container…',
  // No fixed minutes in the label: the window is per-platform (30 min for
  // GTNH, 20 for CurseForge/Modrinth, 10 otherwise - see upgrade.js).
  monitoring: 'Starting & monitoring the new version…',
  overlay: 'Re-applying custom overlay mods…',
};

// Long operation - returns {ok, taskId}; poll /api/tasks/:id (client: runTask).
// On failure with a rollback path, the task RESOLVES with
// {ok:false, error, rollbackAvailable:true} so the client can offer rollback.
router.post(
  '/servers/:id/pack/upgrade',
  requireCap('content'),
  asyncHandler((req, res, next) => {
    const { versionId, skipBackup } = z
      .object({
        // Same shape constraint as the other pack versionId fields: this one
        // reaches the exact same GTNH_PACK_VERSION/CF_FILE_ID/etc. container
        // env path via upgradePack.
        versionId: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        skipBackup: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const taskId = tasks.run(`Upgrading pack on ${server.display_name}…`, { serverId: server.id, actor }, async (t) => {
      t.step(UPGRADE_STEP_LABELS.resolving);
      try {
        return await upgrade.upgradePack(server.id, {
          versionId,
          skipBackup,
          actor,
          onStep: (s) => t.step(UPGRADE_STEP_LABELS[s] || s),
        });
      } catch (err) {
        if (err.rollbackAvailable) {
          return { ok: false, error: err.message, rollbackAvailable: true };
        }
        throw err;
      }
    });
    res.status(202).json({ ok: true, taskId });
  })
);

// Long operation - returns {ok, taskId}. Without an explicit backupId the most
// recent pre-update backup for this server is restored alongside the re-pin.
router.post(
  '/servers/:id/pack/rollback',
  requireCap('content'),
  asyncHandler((req, res, next) => {
    const body = z.object({ backupId: z.string().trim().max(40).optional() }).parse(req.body);
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const backupId =
      body.backupId ||
      db.get(
        "SELECT id FROM backups WHERE server_id = ? AND reason = 'pre-update' ORDER BY created_at DESC LIMIT 1",
        server.id
      )?.id ||
      null;
    const taskId = tasks.run(
      `Rolling back pack on ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        t.step(backupId ? 'Restoring pre-update backup & re-pinning…' : 'Re-pinning previous version…');
        return upgrade.rollbackPack(server.id, { backupId: backupId || undefined, actor });
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

// ---- Pack browser - search, details, installed pack mods, one-shot create ----
const curseforgeApi = require('../../../services/curseforgeApi');
const modrinthApi = require('../../../services/modrinthApi');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');

/** Sanitize platform-provided pack descriptions (Modrinth markdown→HTML, CF raw HTML). */
function sanitizePackHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'del',
      'code',
      'pre',
      'a',
      'ul',
      'ol',
      'li',
      'br',
      'hr',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'img',
      'span',
      'div',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'details',
      'summary',
      'center',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener', target: '_blank' }) },
  });
}

// Search modpacks on Modrinth (no key) or CurseForge (needs the stored key).
router.get(
  '/packs/search',
  asyncHandler(async (req, res, next) => {
    const { q, platform } = z
      .object({
        q: z.string().trim().min(1).max(120),
        platform: z.enum(['modrinth', 'curseforge']).default('modrinth'),
      })
      .parse({ q: req.query.q, platform: req.query.platform || undefined });
    let results;
    if (platform === 'modrinth') {
      results = (await modrinthApi.search({ query: q, kind: 'modpack' })).map((h) => ({
        platform,
        ref: h.slug,
        name: h.title,
        iconUrl: h.iconUrl,
        downloads: h.downloads,
        description: h.description,
      }));
    } else {
      results = (await curseforgeApi.search({ query: q, kind: 'modpack' })).map((m) => ({
        platform,
        ref: m.slug,
        name: m.name,
        iconUrl: m.iconUrl,
        downloads: m.downloads,
        description: m.summary,
      }));
    }
    res.json({ ok: true, results });
  })
);

// Pack details for the shared details modal. Accepts platform+ref OR serverId
// (installed pack - platform/ref come from the server's pin, and the pinned
// version is echoed back so the UI can mark it).
router.get(
  '/packs/details',
  asyncHandler(async (req, res, next) => {
    const query = z
      .object({
        platform: z.enum(['curseforge', 'modrinth']).optional(),
        ref: z.string().trim().min(1).max(400).optional(),
        serverId: z.string().trim().max(40).optional(),
      })
      .refine((v) => Boolean(v.serverId) || (v.platform && v.ref), {
        message: 'Provide either a platform and reference, or a server.',
      })
      .parse({
        platform: req.query.platform || undefined,
        ref: req.query.ref || undefined,
        serverId: req.query.serverId || undefined,
      });

    let { platform, ref } = query;
    let installed = null;
    if (query.serverId) {
      const server = requireServer(query.serverId);
      if (!permissions.can(req.user, server.id, 'view')) throw httpError(404, 'Server not found.');
      const pin = packs.getPack(server.id);
      if (!pin) throw Object.assign(new Error('This server has no managed modpack.'), { status: 404 });
      if (pin.platform === 'ftb')
        throw Object.assign(new Error('FTB pack details are not supported yet.'), { status: 400 });
      if (pin.platform === 'gtnh')
        throw Object.assign(new Error('GTNH pack details live on the GTNH site.'), { status: 400 });
      platform = pin.platform;
      ref = pin.project_ref;
      installed = {
        serverId: server.id,
        serverName: server.display_name,
        versionId: pin.pinned_version_id,
        versionName: pin.pinned_version_name,
      };
    }

    const resolved = await packs.resolvePack(platform, ref, {});
    let description;
    let downloads;
    let author = null;
    if (platform === 'modrinth') {
      const project = await modrinthApi.getProject(resolved.projectRef);
      downloads = project.downloads ?? null;
      description = sanitizePackHtml(marked.parse(String(project.body || ''), { async: false }));
    } else {
      const project = await curseforgeApi.getMod(Number(resolved.projectId));
      downloads = project.downloads ?? null;
      description = sanitizePackHtml(await curseforgeApi.getDescription(project.modId));
    }
    res.json({
      ok: true,
      pack: {
        platform,
        ref: resolved.projectRef,
        projectId: resolved.projectId,
        name: resolved.projectName,
        iconUrl: resolved.iconUrl || null,
        author,
        downloads,
        description,
        mcVersion: resolved.mcVersion || null,
        loaders: resolved.loaders || null,
        defaultVersionId: resolved.versionId,
        versions: resolved.allVersions || [],
        installed,
      },
    });
  })
);

// Pack-managed content of an installed pack (server_content rows managed_by
// 'pack' + on-disk scan), for the details modal's mod list.
router.get(
  '/servers/:id/pack/mods',
  asyncHandler(async (req, res, next) => {
    requireServer(req.params.id);
    const pin = packs.getPack(req.params.id);
    if (!pin) throw Object.assign(new Error('This server has no managed modpack.'), { status: 404 });
    const all = await require('../../../services/mods').listContent(req.params.id);
    const rows = all
      .filter((m) => m.source === 'pack')
      .map((m) => ({ name: m.name, file: m.file, kind: m.kind, version: m.version, size: m.size, enabled: m.enabled }));
    res.json({ ok: true, pack: { name: pin.project_name, version: pin.pinned_version_name }, mods: rows });
  })
);

const fromPackSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    platform: z.enum(['curseforge', 'modrinth', 'ftb', 'gtnh']),
    ref: z.string().trim().min(1).max(400),
    versionId: z
      .string()
      .trim()
      .regex(/^[\w.-]{1,64}$/)
      .optional(),
    heapMb: z.coerce.number().int().min(512).max(262144).optional(),
    containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
    diskQuotaGb: optNum0(16384),
    portGame: z.coerce.number().int().min(1024).max(65535).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ...dockerOverridesSchema,
  })
  .refine((v) => !v.containerMemoryMb || !v.heapMb || v.containerMemoryMb > v.heapMb, {
    message:
      'Container memory limit must be higher than the Java heap, or the server will be stopped for running out of memory.',
  });

// One-shot "create server from modpack": resolve (pin) → create (image pull
// progress included) → apply pack → start, all inside ONE task so the wizard
// shows real progress end to end. Returns {ok, taskId}; task result {serverId}.
router.post(
  '/servers/from-pack',
  asyncHandler((req, res, next) => {
    const input = fromPackSchema.parse(req.body);
    requireAdminForOverrides(req, input);
    const actor = req.user.username;
    const taskId = tasks.run(`Creating ${input.name} from a ${input.platform} pack…`, { actor }, async (t) => {
      t.step('Resolving pack version (pinned, never "latest")…');
      const resolved = await packs.resolvePack(input.platform, input.ref, { versionId: input.versionId });
      const { TYPE: type, ...pinnedSelectors } = packs.packEnv(resolved);
      t.step('Creating server…');
      const server = await servers.createServer(
        {
          name: input.name,
          description: input.description,
          icon: input.icon,
          accent: input.accent,
          type,
          mcVersion: resolved.mcVersion || 'LATEST',
          env: { ...(input.env || {}), ...pinnedSelectors },
          heapMb: input.heapMb,
          containerMemoryMb: input.containerMemoryMb,
          diskQuotaGb: input.diskQuotaGb,
          portGame: input.portGame,
          containerName: input.containerName,
          networkName: input.networkName,
          extraPorts: input.extraPorts,
          extraBinds: input.extraBinds,
        },
        // javaTagHint (not persisted as java_tag - that column means "user override"):
        // at create time there's no server_packs row yet, so resolveImage() would
        // otherwise fall back to java17 for GTNH, pull that image, then immediately
        // re-pull the correct one when the applyPack below flags a recreate.
        { actor, start: false, onProgress: (s) => t.step(s), javaTagHint: resolved.javaTag }
      );
      t.step(`Pinning ${resolved.projectName} @ ${resolved.versionName}…`);
      // force: fresh server - there is no world yet to version-guard.
      await packs.applyPack(server.id, resolved, { actor, force: true });
      t.step('Starting the server (the pack downloads and installs on first boot)…');
      await servers.startServer(server.id, { actor });
      return {
        serverId: server.id,
        name: server.display_name,
        pack: { name: resolved.projectName, version: resolved.versionName, mcVersion: resolved.mcVersion },
      };
    });
    res.status(202).json({ ok: true, taskId });
  })
);

// Long operation - returns {ok, taskId}; the task result is the findings array.
router.post(
  '/updates/check',
  asyncHandler((req, res, next) => {
    const actor = req.user.username;
    const taskId = tasks.run('Checking for updates…', { actor }, async (t) => {
      t.step(
        'Querying Modrinth, CurseForge, Hangar, SpigotMC and GitHub for mods/plugins, plus the Minecraft, loader-build and Docker-image registries…'
      );
      const findings = await checker.checkAll({ actor });
      return { findings };
    });
    res.status(202).json({ ok: true, taskId });
  })
);

// Ignore / un-ignore the update currently offered for one Updates-page row.
// Content rows route to the per-mod store (server_content.ignored_update_version);
// pack / image / mc_version / loader_build rows to update_checks.ignored_version.
// An ignored row stays visible (greyed) on the Updates page but drops out of the
// sidebar badge and the digest; a genuinely newer build re-surfaces on its own.
router.post(
  '/updates/ignore',
  asyncHandler(async (req, res, next) => {
    const { subjectType, serverId, contentId, ignore } = z
      .object({
        subjectType: z.enum(['content', 'pack', 'image', 'mc_version', 'loader_build']),
        serverId: z.string().trim().max(40).optional(),
        contentId: z.string().trim().max(40).optional(),
        ignore: z.boolean(),
      })
      .parse(req.body);
    const actor = req.user.username;
    // Ignoring an update is a content decision on that server.
    if (serverId) {
      const perms = permissions.effective(req.user, serverId);
      if (!perms.includes('view')) throw httpError(404, 'Server not found.');
      if (!perms.includes('content')) throw httpError(403, "You don't have the content permission on this server.");
    }
    if (subjectType === 'content') {
      if (!serverId || !contentId) {
        throw Object.assign(new Error('serverId and contentId are required for content.'), { status: 400 });
      }
      const server = requireServer(serverId);
      const out = mods.setIgnoredUpdate(server.id, { contentId }, { ignore, actor });
      return res.json({ ok: true, ...out });
    }
    if (!serverId) throw Object.assign(new Error('serverId is required.'), { status: 400 });
    const server = requireServer(serverId);
    const out = checker.setUpdateIgnored(subjectType, server.id, { ignore, actor });
    res.json({ ok: true, ...out });
  })
);

// Per-server update-check trigger. The checker runs globally (checkAll);
// the task result is scoped to this server's findings.
router.post(
  '/servers/:id/updates/check',
  requireCap('content'),
  asyncHandler((req, res, next) => {
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const taskId = tasks.run(
      `Checking updates for ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Querying Modrinth, CurseForge, Hangar, SpigotMC, GitHub and the Minecraft/loader/image registries…');
        const findings = await checker.checkAll({ actor });
        return { findings: findings.filter((f) => f.server === server.display_name) };
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

// Docker image update: the check already pulled the newer image under the
// server's current tag, so this is just a normal recreate (stop → remove →
// ensureImage [no-op, already local] → create → restart-if-was-running).
// No pre-update backup: the bind-mounted data dir is untouched by an image swap.
router.post(
  '/servers/:id/image/upgrade',
  requireCap('settings'),
  asyncHandler((req, res, next) => {
    const server = requireServer(req.params.id);
    const actor = req.user.username;
    const taskId = tasks.run(
      `Updating container image on ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Rebuilding the server with the newer image…');
        await servers.recreateServer(server.id, { actor });
        return { ok: true };
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

// Standalone (non-modpack) Minecraft version / loader-build update. envKey
// comes from the Updates page row (computed server-side by the checker, which
// already knows this server's loader) rather than re-derived here, so this
// route only needs to validate it's one of the itzg build-pin vars it knows
// how to write.
const LOADER_BUILD_ENV_KEYS = [
  'PAPER_BUILD',
  'FORGE_VERSION',
  'NEOFORGE_VERSION',
  'FABRIC_LOADER_VERSION',
  'QUILT_LOADER_VERSION',
];

router.post(
  '/servers/:id/mcversion/upgrade',
  requireCap('settings'),
  asyncHandler(async (req, res, next) => {
    const { targetVersion, targetLoaderBuild, envKey, force } = z
      .object({
        targetVersion: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,32}$/)
          .optional(),
        targetLoaderBuild: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,64}$/)
          .optional(),
        envKey: z.enum(LOADER_BUILD_ENV_KEYS).optional(),
        force: z.boolean().optional().default(false),
      })
      .refine((v) => Boolean(v.targetVersion) || Boolean(v.targetLoaderBuild && v.envKey), {
        message: 'Provide a target version, or a target loader build with its env key.',
      })
      .parse(req.body);
    const server = requireServer(req.params.id);
    const actor = req.user.username;

    // A Minecraft version change on a modded server has to be earned: every
    // installed mod needs a build for the target, established by a version
    // check (#52). `force` is the deliberate override - it is only ever sent
    // after the panel has shown which mods would be left behind.
    if (targetVersion && targetVersion !== server.mc_version && !force) {
      const verdict = require('../../../services/compat').upgradeVerdict(server.id, targetVersion);
      // Answered here rather than thrown: the client needs the blocking mods
      // to show, and the shared JSON error handler carries only a message.
      if (!verdict.allowed) {
        return res.status(409).json({
          ok: false,
          error: verdict.message,
          compat: {
            reason: verdict.reason,
            targetVersion,
            missing: verdict.missing,
            missingCount: verdict.missingCount,
            unknownCount: verdict.unknownCount,
          },
        });
      }
    }
    // Plugin-family gate (#53): Paper & forks ship per-MC builds that lag
    // Mojang, so an unmodded target the loader has not published is refused
    // unless explicitly forced - the same override contract as the compat gate.
    // The probe is authoritative only when it HEARD back; an outage passes.
    if (
      targetVersion &&
      targetVersion !== server.mc_version &&
      !force &&
      require('../../../services/mods').loaderOf(server) === 'paper'
    ) {
      const gate = await require('../../../services/loaderVersions').mcAvailableOnServerType(
        server.type,
        targetVersion,
        {
          channel: server.env.PAPER_CHANNEL || 'default',
        }
      );
      if (!gate.supported) {
        const flavor = require('../../../web/viewModels').flavorLabel(server.type);
        return res.status(409).json({
          ok: false,
          error: `${flavor} has not published a Minecraft ${targetVersion} build yet. Switch this server to the experimental channel to track pre-releases, or pick a released version.`,
        });
      }
    }
    const taskId = tasks.run(
      `Updating Minecraft version on ${server.display_name}…`,
      { serverId: server.id, actor },
      async (t) => {
        const versionChanging = targetVersion && targetVersion !== server.mc_version;
        let backupId = null;
        if (versionChanging) {
          t.step('Creating pre-update backup…');
          const backup = await backups.createBackup(server.id, {
            reason: 'pre-update',
            actor,
            note: `Before Minecraft ${server.mc_version} → ${targetVersion}`,
            task: t,
          });
          backupId = backup.id;
        }
        t.step('Applying new version…');
        const changes = {};
        if (versionChanging) changes.mcVersion = targetVersion;
        if (targetLoaderBuild && envKey) changes.env = { ...server.env, [envKey]: targetLoaderBuild };
        servers.updateServer(server.id, changes, { actor });
        t.step('Rebuilding the server…');
        await servers.recreateServer(server.id, { actor });
        return { ok: true, from: server.mc_version, to: targetVersion || server.mc_version, backupId };
      }
    );
    res.status(202).json({ ok: true, taskId });
  })
);

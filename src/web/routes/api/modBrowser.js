// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Unified mod browser and the create-from-mods/zip/native-loader flows.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { z } = require('zod');
const servers = require('../../../services/servers');
const tasks = require('../../../services/tasks');
const { dataPath } = require('../../../storage/pathGuard');
const { dockerOverridesSchema, requireAdminForOverrides } = require('../dockerOverridesSchema');
const logger = require('../../../logger')('api');
const { serializeError } = require('../../../utils/logSanitize');
const contentZip = require('../../../services/contentZip');
const mods = require('../../../services/mods');
const router = require('./router');
const { optNum0, zipImportUpload, zipTokenSchema } = require('./shared');

// ---- Unified mod browser (wizard "From mods" + per-server mods tab) ----
const modBrowser = require('../../../services/modBrowser');
const loaderVersions = require('../../../services/loaderVersions');

const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
// Plugin servers report 'paper' as their loader; the browser strips it for
// plugin searches server-side, but the schema must let it through.
const BROWSER_LOADERS = [...MOD_LOADERS, 'paper'];
const CONTENT_KINDS = ['mod', 'plugin', 'datapack', 'resourcepack'];

// Loader build versions to pin (fabric/quilt are MC-independent; neoforge/forge need mc).
router.get(
  '/loaders/versions',
  asyncHandler(async (req, res, next) => {
    const { loader, mc } = z
      .object({ loader: z.enum(MOD_LOADERS), mc: z.string().trim().max(32).optional() })
      .parse({ loader: req.query.loader, mc: req.query.mc || undefined });
    res.json({ ok: true, ...(await loaderVersions.getBuilds(loader, mc)) });
  })
);

// Unified mod/plugin search across Modrinth / CurseForge, filtered to loader + MC.
router.get(
  '/mods/search',
  asyncHandler(async (req, res, next) => {
    const { q, platform, kind, loader, mc } = z
      .object({
        q: z.string().trim().max(120).default(''),
        platform: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']).default('modrinth'),
        kind: z.enum(CONTENT_KINDS).default('mod'),
        loader: z.enum(BROWSER_LOADERS).optional(),
        mc: z.string().trim().max(32).optional(),
      })
      .parse({
        q: req.query.q || '',
        platform: req.query.platform || undefined,
        kind: req.query.kind || undefined,
        loader: req.query.loader || undefined,
        mc: req.query.mc || undefined,
      });
    res.json({ ok: true, results: await modBrowser.search({ query: q, platform, kind, loader, mc }) });
  })
);

// A mod's builds for the chosen loader + MC, newest first (for its version picker).
router.get(
  '/mods/versions',
  asyncHandler(async (req, res, next) => {
    const { platform, ref, kind, loader, mc } = z
      .object({
        platform: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']),
        ref: z.string().trim().min(1).max(200),
        kind: z.enum(CONTENT_KINDS).default('mod'),
        loader: z.enum(BROWSER_LOADERS).optional(),
        mc: z.string().trim().max(32).optional(),
      })
      .parse({
        platform: req.query.platform,
        ref: req.query.ref,
        kind: req.query.kind || undefined,
        loader: req.query.loader || undefined,
        mc: req.query.mc || undefined,
      });
    res.json({ ok: true, versions: await modBrowser.versions({ platform, ref, kind, loader, mc }) });
  })
);

// Required-dependency closure of the current selection ("added as dependency" rows).
router.post(
  '/mods/deps',
  asyncHandler(async (req, res, next) => {
    const { loader, mc, selection } = z
      .object({
        loader: z.enum(MOD_LOADERS),
        mc: z.string().trim().max(32).optional(),
        selection: z
          .array(
            z.object({
              platform: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']),
              ref: z.string().trim().min(1).max(200),
              versionId: z.string().trim().min(1).max(60),
            })
          )
          .max(50),
      })
      .parse(req.body);
    res.json({ ok: true, ...(await modBrowser.resolveDependencies({ loader, mc, selection })) });
  })
);

const fromModsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    // 'paper' is accepted for the Auto-detect (solver) path, which can pick a
    // plugin loader; the browse UI only offers the four mod loaders.
    loader: z.enum([...MOD_LOADERS, 'paper']),
    mcVersion: z.string().trim().min(1).max(32),
    loaderVersion: z.string().trim().max(40).optional(),
    mods: z
      .array(
        z.object({
          platform: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']),
          ref: z.string().trim().min(1).max(200),
          versionId: z.string().trim().min(1).max(60).optional(),
        })
      )
      .max(100)
      .default([]),
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

// One-shot "create server from mods": create (no start) → install each mod
// pinned to its chosen build → start, all inside ONE task with real progress.
// Individual mod failures are tolerated and reported; the server still comes up.
router.post(
  '/servers/from-mods',
  asyncHandler((req, res, next) => {
    const input = fromModsSchema.parse(req.body);
    requireAdminForOverrides(req, input);
    const actor = req.user.username;
    const type = input.loader.toUpperCase(); // fabric → FABRIC, etc. (all valid TYPEs)
    const taskId = tasks.run(`Creating ${input.name} (${input.loader})…`, { actor }, async (t) => {
      const env = { ...(input.env || {}) };
      const envKey = loaderVersions.envKeyFor(input.loader);
      if (input.loaderVersion && envKey) env[envKey] = input.loaderVersion;
      t.step('Creating server…');
      const server = await servers.createServer(
        {
          name: input.name,
          description: input.description,
          icon: input.icon,
          accent: input.accent,
          type,
          mcVersion: input.mcVersion,
          env,
          heapMb: input.heapMb,
          containerMemoryMb: input.containerMemoryMb,
          diskQuotaGb: input.diskQuotaGb,
          portGame: input.portGame,
          containerName: input.containerName,
          networkName: input.networkName,
          extraPorts: input.extraPorts,
          extraBinds: input.extraBinds,
        },
        { actor, start: false, onProgress: (s) => t.step(s) }
      );
      // Install mods BEFORE first boot so a loader server starts with them present.
      const failed = [];
      for (let i = 0; i < input.mods.length; i += 1) {
        const m = input.mods[i];
        // With a versionId the build is pinned; without one (the solver path)
        // installFromUrl picks the newest build matching this server's loader+MC.
        const base =
          m.platform === 'curseforge'
            ? `https://www.curseforge.com/minecraft/mc-mods/${m.ref}`
            : m.platform === 'hangar'
              ? `https://hangar.papermc.io/p/${m.ref}` // owner segment is decorative
              : m.platform === 'spiget'
                ? `https://www.spigotmc.org/resources/${m.ref}`
                : `https://modrinth.com/mod/${m.ref}`;
        const url = m.versionId
          ? m.platform === 'curseforge'
            ? `${base}/files/${m.versionId}`
            : m.platform === 'hangar'
              ? `${base}/versions/${encodeURIComponent(m.versionId)}`
              : m.platform === 'spiget'
                ? `${base}?version=${m.versionId}`
                : `${base}/version/${m.versionId}`
          : base;
        t.step(`Installing mod ${i + 1}/${input.mods.length}: ${m.ref}…`);
        try {
          await mods.installFromUrl(server.id, url, { actor });
        } catch (err) {
          failed.push(`${m.ref} (${err.message})`);
          logger.warn('A mod failed to install during create-from-mods.', {
            serverId: server.id,
            mod: m.ref,
            platform: m.platform,
            err: serializeError(err, { includeStack: false }),
          });
        }
      }
      t.step('Starting server…');
      await servers.startServer(server.id, { actor });
      return {
        serverId: server.id,
        name: server.display_name,
        installed: input.mods.length - failed.length,
        total: input.mods.length,
        failed,
      };
    });
    res.status(202).json({ ok: true, taskId });
  })
);

// Server-less zip preview for the wizard's "create from zip" flow — same
// two-phase token contract as the per-server preview.
router.post(
  '/mods/zip-preview',
  zipImportUpload.single('file'),
  asyncHandler(async (req, res, next) => {
    if (!req.file) throw Object.assign(new Error('No file uploaded.'), { status: 400 });
    let preview;
    try {
      preview = await contentZip.previewStandalone(req.file.path);
    } catch (err) {
      await fsp.rm(req.file.path, { force: true }).catch(() => {});
      throw err;
    }
    res.json({ ok: true, preview, uploadToken: req.file.filename });
  })
);

const fromZipSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).optional(),
    icon: z.string().max(64).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    // 'paper' covers zips of plugins — the digester infers the kind.
    loader: z.enum([...MOD_LOADERS, 'paper']),
    mcVersion: z.string().trim().min(1).max(32),
    loaderVersion: z.string().trim().max(40).optional(),
    // Native-loader mode: the zip already contains a complete, installed
    // loader (a locally-prepared server pack) - the detected loader build is
    // used to pin the container instead of asking the user to type one.
    nativeLoader: z.coerce.boolean().optional(),
    uploadToken: zipTokenSchema,
    selections: z
      .array(z.union([z.coerce.number(), z.string().max(300)]))
      .max(1500)
      .optional(),
    applyOverrides: z.coerce.boolean().optional(),
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

// What detectNativeLoader() may hand the create path: plain version tokens only.
const nativeLoaderSchema = z.object({
  loader: z
    .enum([...MOD_LOADERS, 'paper'])
    .nullable()
    .optional(),
  mcVersion: z
    .string()
    .regex(/^[A-Za-z0-9][\w.+-]{0,31}$/)
    .nullable()
    .optional(),
  loaderVersion: z
    .string()
    .regex(/^[A-Za-z0-9][\w.+-]{0,39}$/)
    .nullable()
    .optional(),
});

// One-shot "create server from an uploaded zip": create (no start) → bulk
// install the zip's mods → optional overrides → start, all inside ONE task.
// Same tolerance contract as from-mods: per-mod failures are reported, the
// server still comes up.
router.post(
  '/servers/from-zip',
  asyncHandler(async (req, res, next) => {
    const input = fromZipSchema.parse(req.body);
    requireAdminForOverrides(req, input);
    const zipPath = dataPath('tmp', input.uploadToken);
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ ok: false, error: 'The uploaded zip expired. Upload it again.' });
    }
    const actor = req.user.username;
    const env = { ...(input.env || {}) };
    // Native-loader mode: reconcile the container to the loader that's already
    // installed inside the zip (detected server-side - the client's numbers are
    // never trusted for this) rather than requiring an explicit loader version.
    // itzg's start script then reuses the installed build instead of laying
    // down a fresh loader over the pack's files.
    let loader = input.loader;
    let mcVersion = input.mcVersion;
    let loaderVersion = input.loaderVersion;
    if (input.nativeLoader) {
      const native = await contentZip.detectNativeLoader(zipPath).catch(() => null);
      if (native) {
        // Detected from zip entry names, so hold them to the same shape the
        // typed fields get before they reach the env / DB.
        const detected = nativeLoaderSchema.safeParse(native);
        if (!detected.success) {
          throw Object.assign(
            new Error(
              'The loader inside this zip could not be read safely. Untick the native-loader option and pick the loader by hand.'
            ),
            { status: 422 }
          );
        }
        if (detected.data.loader) loader = detected.data.loader;
        if (detected.data.mcVersion) mcVersion = detected.data.mcVersion;
        if (detected.data.loaderVersion) loaderVersion = detected.data.loaderVersion;
      }
    }
    const type = loader.toUpperCase();
    const taskId = tasks.run(`Creating ${input.name} from zip…`, { actor }, async (t) => {
      try {
        const envKey = loader !== 'paper' ? loaderVersions.envKeyFor(loader) : null;
        if (loaderVersion && envKey) env[envKey] = loaderVersion;
        t.step('Creating server…');
        const server = await servers.createServer(
          {
            name: input.name,
            description: input.description,
            icon: input.icon,
            accent: input.accent,
            type,
            mcVersion,
            env,
            heapMb: input.heapMb,
            containerMemoryMb: input.containerMemoryMb,
            diskQuotaGb: input.diskQuotaGb,
            portGame: input.portGame,
            containerName: input.containerName,
            networkName: input.networkName,
            extraPorts: input.extraPorts,
            extraBinds: input.extraBinds,
          },
          { actor, start: false, onProgress: (s) => t.step(s) }
        );
        // Install BEFORE first boot so the loader server starts with mods present.
        const report = await contentZip.importForServer(server.id, zipPath, {
          selections: input.selections || null,
          applyOverrides: Boolean(input.applyOverrides),
          actor,
          onStep: (s) => t.step(s),
        });
        t.step('Starting server…');
        await servers.startServer(server.id, { actor });
        return { serverId: server.id, name: server.display_name, report };
      } finally {
        await fsp.rm(zipPath, { force: true }).catch(() => {});
      }
    });
    res.status(202).json({ ok: true, taskId });
  })
);

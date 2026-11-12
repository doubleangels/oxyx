// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Panel settings: public domain, update check, new-server defaults, localization.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const logger = require('../../../logger')('api');
const apiKeys = require('../../../services/apiKeys');
const panelUpdate = require('../../../services/panelUpdate');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const router = require('./router');

// ---- Panel settings (public domain, shown instead of the LAN IP) ----
const settingsService = require('../../../services/settings');
const panelConfig = require('../../../config');

// COOKIE_SECURE defaults to false so a plain-HTTP LAN/localhost session still
// works (see config/index.js resolveCookieSecure) - reasonable for a LAN-only
// deployment, but a public host being configured here means this panel is
// expected to be reachable over the internet (e.g. via the invite/port-forward
// feature), where a non-Secure session cookie is sniffable in transit.
function cookieSecureWarning(publicHost) {
  return Boolean(publicHost) && panelConfig.cookieSecure === false;
}

router.get('/settings', (req, res) => {
  const publicHost = settingsService.getPublicHost();
  res.json({
    ok: true,
    publicHost,
    cookieSecureWarning: cookieSecureWarning(publicHost),
    curseforge: { masked: apiKeys.maskedKey('curseforge') },
  });
});

// ---- Panel self-update check ("Update MSM"). Admin-only, on-demand: the
// Settings page never hits GitHub at render - the button triggers this GET.
router.get(
  '/settings/panel-update',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    res.json({ ok: true, update: await panelUpdate.checkLatest({ refresh: req.query.refresh === '1' }) });
  })
);

// ---- Defaults for new servers (admin-configured wizard/blueprint pre-fills) ----
router.get('/settings/defaults', (req, res) => {
  res.json({ ok: true, defaults: settingsService.getDefaults(), base: panelConfig.defaults });
});

router.post(
  '/settings/defaults',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const num = () =>
      z
        .union([z.string(), z.number()])
        // A cleared input means "leave this field untouched", not "force it to 0".
        .transform((v) => (v === '' || v === null ? undefined : Number(v)))
        .optional();
    const { reset, heapMb, containerMemoryMb, cpus, diskQuotaGb, quotaWarnPct, quotaCriticalPct } = z
      .object({
        reset: z.boolean().optional(),
        heapMb: num(),
        containerMemoryMb: num(),
        cpus: num(),
        diskQuotaGb: num(),
        quotaWarnPct: num(),
        quotaCriticalPct: num(),
      })
      .parse(req.body);
    const defaults = reset
      ? settingsService.resetDefaults()
      : settingsService.setDefaults({
          heapMb,
          containerMemoryMb,
          cpus,
          diskQuotaGb,
          quotaWarnPct,
          quotaCriticalPct,
        });
    res.json({ ok: true, defaults, base: panelConfig.defaults });
  })
);

router.post(
  '/settings',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const { publicHost } = z.object({ publicHost: z.string().max(255).optional() }).parse(req.body);
    const saved = settingsService.setPublicHost(publicHost || '');
    const warn = cookieSecureWarning(saved);
    if (warn) {
      logger.warn(
        'A public host is configured but COOKIE_SECURE is unset, so the session cookie is sent over plain HTTP if the panel is reached that way. Set COOKIE_SECURE=true behind HTTPS, or COOKIE_SECURE=auto together with TRUST_PROXY, in the environment.',
        { publicHost: saved }
      );
    }
    res.json({ ok: true, publicHost: saved, cookieSecureWarning: warn });
  })
);

// ---- Localization: timezone + country (auto-detected from the host by default) ----
router.get('/settings/localization', (req, res) => {
  res.json({ ok: true, localization: settingsService.localization() });
});

router.post(
  '/settings/localization',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const { timezone, country } = z
      .object({
        timezone: z.string().max(64).optional(),
        country: z.string().max(8).optional(),
      })
      .parse(req.body);
    if (timezone !== undefined) {
      settingsService.setTimezone(timezone);
      // Already-armed schedules keep firing on whatever zone they were
      // created with until re-armed - do it now, not just for new ones.
      require('../../../services/scheduler').rearmAll();
    }
    if (country !== undefined) settingsService.setCountry(country);
    res.json({ ok: true, localization: settingsService.localization() });
  })
);

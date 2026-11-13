'use strict';

// Public read-only API tokens. Admin only.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const { boolish } = require('../../../utils/boolish');
const eventsService = require('../../../events');
const logger = require('../../../logger')('api');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');
const settingsService = require('../../../services/settings');
const router = require('./router');
const { requireServer } = require('./shared');

// ---- Public read-only API tokens (Settings page) - admin only ----
// These manage credentials for GET /api/v1 (see routes/apiV1.js). The tokens
// themselves are Bearer-only and never touch a session.
const apiTokens = require('../../../services/apiTokens');

router.get('/api-tokens', requireRoleKeys('admin'), (req, res) => {
  res.json({ ok: true, enabled: settingsService.isPublicApiEnabled(), tokens: apiTokens.listTokens() });
});

const apiTokenCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    scopeAll: boolish.default(false),
    serverIds: z
      .array(
        z
          .string()
          .trim()
          .regex(/^srv_[A-Za-z0-9_-]{1,40}$/)
      )
      .max(200)
      .optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine((v) => v.scopeAll || (v.serverIds && v.serverIds.length > 0), {
    message: 'Choose specific servers or grant access to all servers.',
  });

router.post(
  '/api-tokens',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const input = apiTokenCreateSchema.parse(req.body);
    if (!input.scopeAll) for (const id of input.serverIds || []) requireServer(id); // 404 on unknown id
    const created = apiTokens.createToken(
      {
        label: input.label,
        scopeAll: input.scopeAll,
        serverIds: input.scopeAll ? [] : input.serverIds,
        expiresAt: input.expiresAt || null,
      },
      { actor: req.user.username }
    );
    // A token that can't be used is a footgun - minting one turns the surface
    // on. Turning it back off stays a deliberate, separate action.
    let enabled = settingsService.isPublicApiEnabled();
    if (!enabled) {
      enabled = settingsService.setPublicApiEnabled(true);
      eventsService.recordEvent({
        actor: req.user.username,
        type: 'config-changed',
        summary: 'Public API enabled (first token created).',
      });
      logger.info('Enabled the public API alongside a new token.', { actor: req.user.username });
    }
    // created.token is the plaintext - returned to the caller exactly once.
    res.status(201).json({ ok: true, token: created, enabled });
  })
);

router.delete(
  '/api-tokens/:id',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    apiTokens.revokeToken(req.params.id, { actor: req.user.username }); // throws 404 if unknown/already revoked
    res.json({ ok: true });
  })
);

router.post(
  '/settings/public-api',
  requireRoleKeys('admin'),
  asyncHandler((req, res, next) => {
    const { enabled } = z.object({ enabled: boolish }).parse(req.body);
    const now = settingsService.setPublicApiEnabled(enabled);
    eventsService.recordEvent({
      actor: req.user.username,
      type: 'config-changed',
      summary: `Public API ${now ? 'enabled' : 'disabled'}.`,
    });
    logger.info('Toggled the public API.', { enabled: now, actor: req.user.username });
    res.json({ ok: true, enabled: now });
  })
);

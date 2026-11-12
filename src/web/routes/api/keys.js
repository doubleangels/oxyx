// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Platform API keys (CurseForge and friends). Admin only.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const router = require('./router');

// ---- API keys (Settings page) - admin only ----
const apiKeys = require('../../../services/apiKeys');
const { requireRole: requireRoleKeys } = require('../../middleware/auth');

router.get('/keys', (req, res) => {
  res.json({ ok: true, curseforge: { masked: apiKeys.maskedKey('curseforge') } });
});

router.post(
  '/keys/curseforge',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    const { key } = z.object({ key: z.string().trim().min(10).max(200) }).parse(req.body);
    const test = await apiKeys.testCurseForgeKey(key);
    if (!test.ok)
      return res
        .status(400)
        .json({ ok: false, error: test.error || 'That CurseForge key could not be verified. Check it and try again.' });
    apiKeys.setKey('curseforge', key, { actor: req.user.username });
    res.json({ ok: true });
  })
);

router.post(
  '/keys/curseforge/test',
  requireRoleKeys('admin'),
  asyncHandler(async (req, res, next) => {
    res.json(await apiKeys.testCurseForgeKey());
  })
);

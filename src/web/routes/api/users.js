'use strict';

// Users, per-server permissions, sign-in lockouts, account recovery.
// Registers on the shared /api router (./router.js); api.js loads these in order.

const asyncHandler = require('../../middleware/asyncHandler');
const { z } = require('zod');
const { boolish } = require('../../../utils/boolish');
const permissions = require('../../../services/permissions');
const httpError = require('../../../utils/httpError');
const eventsService = require('../../../events');
const { removeAvatarFiles } = require('../../../services/avatarStore');
const logger = require('../../../logger')('api');
const router = require('./router');

// ---- Users (admin only) ----
const authService = require('../../../services/auth');
const { requireRole } = require('../../middleware/auth');

router.get('/users', requireRole('admin'), (req, res) => {
  res.json({ ok: true, users: authService.listUsers() });
});

// ---- Per-server permissions (Settings → Permissions) ----
router.get('/permissions', requireRole('admin'), (req, res) => {
  res.json({ ok: true, ...permissions.listMatrix() });
});

router.put(
  '/permissions/:userId/:serverId',
  requireRole('admin'),
  asyncHandler((req, res, next) => {
    if (!req.body || !('perms' in req.body)) {
      throw httpError(400, 'Send a list of permissions, or null to use the role default.');
    }
    const { perms } = z.object({ perms: z.array(z.string().max(20)).max(32).nullable() }).parse(req.body);
    const result = permissions.setGrant(req.params.userId, req.params.serverId, perms, {
      actor: req.user.username,
    });
    res.json({ ok: true, ...result });
  })
);

// ---- Sign-in lockouts (in-memory; admin visibility + manual unlock) ----
const authMw = require('../../middleware/auth');

router.get('/auth/lockouts', requireRole('admin'), (req, res) => {
  res.json({ ok: true, lockouts: authMw.listActiveLockouts() });
});

router.post(
  '/auth/lockouts/clear',
  requireRole('admin'),
  asyncHandler((req, res, next) => {
    const { username, ip, all } = z
      .object({
        username: z.string().trim().min(1).max(64).optional(),
        ip: z.string().trim().max(64).optional(),
        all: boolish.optional(),
      })
      .parse(req.body || {});
    if (!all && !username) throw Object.assign(new Error('Pass a username, or all:true.'), { status: 400 });
    const removed = authMw.clearLockouts({ username, ip, all: Boolean(all) });
    eventsService.recordEvent({
      actor: req.user.username,
      type: 'login-unlocked',
      summary: all
        ? `${req.user.username} cleared all sign-in lockouts.`
        : `${req.user.username} cleared the sign-in lockout for "${username}".`,
      details: { username: username || null, ip: ip || null, all: Boolean(all), removed },
    });
    res.json({ ok: true, removed, lockouts: authMw.listActiveLockouts() });
  })
);

router.post(
  '/users',
  requireRole('admin'),
  asyncHandler(async (req, res, next) => {
    const { username, password, role } = z
      .object({
        username: z.string().trim().min(2).max(32),
        password: z.string().min(8).max(200),
        role: z.enum(['admin', 'operator', 'viewer']),
      })
      .parse(req.body);
    res.status(201).json({
      ok: true,
      user: await authService.createUser({ username, password, role }, { actor: req.user.username }),
    });
  })
);

router.post(
  '/users/:id/role',
  requireRole('admin'),
  asyncHandler((req, res, next) => {
    const { role } = z.object({ role: z.enum(['admin', 'operator', 'viewer']) }).parse(req.body);
    authService.setRole(req.params.id, role, { actor: req.user.username });
    res.json({ ok: true });
  })
);

router.post(
  '/users/:id/password',
  requireRole('admin'),
  asyncHandler(async (req, res, next) => {
    const { password, currentPassword } = z
      .object({
        password: z.string().min(8).max(200),
        currentPassword: z.string().min(1).max(200),
      })
      .parse(req.body);
    const isSelf = req.params.id === req.user.id;
    // Re-verify the acting admin's own password (shared login lockout), mirroring
    // the account 2FA routes - a hijacked-but-live session can't set any
    // password, including its own, without knowing the real one.
    authMw.checkLoginAllowed(req.user.username, req.ip);
    try {
      // Self password change rotates the ACTING session away too (exceptSid=null):
      // the attacker's preserved session must not survive adopting the new password.
      await authService.changePassword(req.user.id, req.params.id, currentPassword, password, {
        actor: req.user.username,
        exceptSid: isSelf ? null : req.sessionID,
      });
    } catch (err) {
      if (err.status === 401) {
        authMw.recordLoginFailure(req.user.username, req.ip);
        logger.warn('Rejected a password change with a wrong admin password.', { userId: req.user.id, ip: req.ip });
      }
      throw err;
    }
    authMw.clearLoginFailures(req.user.username, req.ip);
    if (isSelf) {
      // Drop the acting session's server-side row + clear its cookie so the
      // client must re-authenticate with the new password.
      req.session.destroy(() => {});
    }
    logger.info('Admin changed a password.', { actor: req.user.username, targetId: req.params.id, isSelf });
    res.json({ ok: true, signedOutAll: isSelf });
  })
);

router.delete(
  '/users/:id',
  requireRole('admin'),
  asyncHandler(async (req, res, next) => {
    authService.deleteUser(req.params.id, { actor: req.user.username });
    // The users.avatar row is gone with the user; drop any uploaded file too so
    // it isn't left orphaned on disk and still fetchable by its stable URL.
    await removeAvatarFiles(req.params.id);
    res.json({ ok: true });
  })
);

// Recovery path when a user loses both their authenticator and their backup
// codes - an admin can force-clear 2FA without knowing their password (same
// trust level as the admin password-reset above). The user re-enrolls fresh.
// Deliberately refuses to target the caller's own account: that would be a
// password-free way to strip your own 2FA that /api/account/totp/disable
// (which does re-check the password) exists specifically to prevent.
router.post(
  '/users/:id/totp/disable',
  requireRole('admin'),
  asyncHandler((req, res, next) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ ok: false, error: "Use your own account's two-factor settings to turn it off." });
    }
    authService.adminDisableTotp(req.params.id, { actor: req.user.username });
    res.json({ ok: true });
  })
);

'use strict';

// Host header check against DNS rebinding. A page on evil.example can rebind
// its own name to 127.0.0.1 and then talk to the panel; Origin and Host both
// say evil.example, so the origin checks pass. Session cookies are host-scoped,
// so a signed-in session is safe, but first-run setup is not: on a loopback
// install it needs no PIN, so a rebinding page could create the admin account
// before the owner does.
//
// Rebinding needs a DOMAIN name, so loopback names and IP literals always pass.
// Any other host must be listed in PANEL_ALLOWED_HOSTS:
//  - always while first-run setup is pending (the exposed window), and
//  - after setup only when PANEL_ALLOWED_HOSTS is set, so an existing install
//    behind a reverse proxy keeps working without new configuration.
// PANEL_ALLOWED_HOSTS=* turns the check off.

const net = require('node:net');
const path = require('node:path');
const config = require('../../config');
const logger = require('../../logger')(path.basename(__filename));

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** 'Example.com:25564' → 'example.com'; '[::1]:80' → '::1'. */
function hostName(raw) {
  const h = String(raw || '')
    .trim()
    .toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const colon = h.lastIndexOf(':');
  return colon > -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

let setupDone = false;
function firstRunPending() {
  if (setupDone) return false;
  // Users are never deleted down to zero, so once set up stays set up.
  setupDone = !require('../../services/auth').firstRunNeeded();
  return !setupDone;
}

/**
 * Whether a request's Host may reach the panel right now.
 * @param {{ headers: Record<string, any> }} req
 */
function hostAllowed(req) {
  const allowed = config.allowedHosts;
  if (allowed.includes('*')) return true;
  const name = hostName(req.headers.host);
  if (LOOPBACK.has(name) || net.isIP(name) || name.endsWith('.localhost')) return true;
  if (allowed.includes(name)) return true;
  // An unlisted domain: refused during first run, or whenever a list is set.
  return !(allowed.length > 0 || firstRunPending());
}

function hostGuard(req, res, next) {
  if (hostAllowed(req)) return next();
  logger.warn('Refused a request for a host name the panel does not answer to.', {
    host: String(req.headers.host || '').slice(0, 255),
    path: req.path,
  });
  const message =
    'This panel does not answer to that host name. Open it by its IP address or at localhost, or add the name to PANEL_ALLOWED_HOSTS.';
  res.status(421);
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: false, error: message });
  return res.type('text/plain').send(message);
}

/** Test seam: forget the cached "setup is done" answer. */
function _resetForTests() {
  setupDone = false;
}

module.exports = { hostGuard, hostAllowed, hostName, _resetForTests };

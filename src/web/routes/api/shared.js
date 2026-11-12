'use strict';

// Helpers more than one /api module uses.

const { z } = require('zod');
const servers = require('../../../services/servers');
const httpError = require('../../../utils/httpError');
const multer = require('multer');
const { dataPath } = require('../../../storage/pathGuard');
// Valid server TYPE values, derived from the field catalog so this stays in sync
// with the wizard. An unknown type would create a container that only fails later
// at start with no useful feedback.
const SERVER_TYPES = require('../../../config/field-catalog/general')
  .find((f) => f.key === 'TYPE')
  .options.map((o) => o.value);

/** Load a server row or throw a JSON-friendly 404. */
function requireServer(id) {
  const server = servers.getServer(id);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

/**
 * Optional 0..max numeric for the cpus / diskQuotaGb inputs. Unlike
 * z.coerce.number(), a cleared/empty field maps to "unset" (use the configured
 * default) instead of a silent 0 - which for a disk quota means "off" and for
 * cpus means "unlimited". An explicit "0" still round-trips.
 */
const optNum0 = (max) =>
  z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => (typeof v === 'string' ? v.trim() : v))
    .transform((v) => (v === '' || v === null ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isFinite(v) && v >= 0 && v <= max),
      `Expected a number between 0 and ${max}`
    )
    .optional();

/** A server row without its secrets, for JSON responses. */
function publicServer(s) {
  if (!s) return null;
  const { rcon_password_cipher, env_json, notes, env, ...rest } = s;
  return rest;
}

// Mod-zip importer upload (mods.js previews, modBrowser.js creates from it).
const { nanoid: zipNanoid } = require('nanoid');
const zipImportUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dataPath('tmp')),
    filename: (req, file, cb) => cb(null, `modzip-${zipNanoid(10)}.zip`),
  }),
  limits: { fileSize: 8 * 1024 ** 3, files: 1 },
});
const zipTokenSchema = z.string().regex(/^modzip-[A-Za-z0-9_-]{10}\.zip$/, 'Invalid upload token.');

module.exports = { SERVER_TYPES, requireServer, optNum0, publicServer, zipImportUpload, zipTokenSchema };

'use strict';

// Parse a JSON column without letting one bad row take a page down. A corrupt
// value (hand-edited database, a write cut off by a crash) returns `fallback`
// and logs one warning per location instead of throwing: `listServers` runs on
// every page for the sidebar, so a single throw there 500'd the whole panel,
// including the pages needed to repair it.

const path = require('node:path');
const logger = require('../logger')(path.basename(__filename));

const warned = new Set();
const MAX_WARNED = 500;

/**
 * @param {unknown} text the stored string (null/undefined/'' read as empty)
 * @param {any} fallback returned when empty, invalid, or the wrong shape
 * @param {{ where?: string, onBad?: () => void }} [opts] `where` names the
 *   column and row for the log; `onBad` runs on an invalid value only
 * @returns {any} the parsed value (stored JSON is untyped)
 */
function safeJsonParse(text, fallback, { where = 'unknown', onBad } = {}) {
  if (text === null || text === undefined || text === '') return fallback;
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return bad(where, fallback, onBad);
  }
  // Same shape as the fallback: an array for an array, an object for an object.
  if (Array.isArray(fallback) !== Array.isArray(value)) return bad(where, fallback, onBad);
  if (fallback !== null && typeof fallback === 'object' && (value === null || typeof value !== 'object')) {
    return bad(where, fallback, onBad);
  }
  return value;
}

function bad(where, fallback, onBad) {
  if (!warned.has(where)) {
    if (warned.size >= MAX_WARNED) warned.clear();
    warned.add(where);
    logger.warn('Ignored a stored value that is not valid JSON.', { where });
  }
  if (onBad) onBad();
  return fallback;
}

module.exports = { safeJsonParse };

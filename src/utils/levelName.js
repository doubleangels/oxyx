'use strict';

// One rule for a world (level) folder name, shared by the settings form, the
// server create/update path and every reader of the active level. A name is a
// single folder directly inside the server folder: no path separators, no NUL,
// not starting with a dot (which also rules out "." and ".."), at most 64
// characters. Anything else could point a per-server operation at another
// server's folder or at the data root.

/** HTML `pattern` form of the rule (no NUL: a form field cannot hold one). */
const LEVEL_NAME_PATTERN = String.raw`[^.\\\/][^\\\/]{0,63}`;

const LEVEL_NAME_RE = /^[^.\\/\0][^\\/\0]{0,63}$/;

/** @param {unknown} name */
function isValidLevelName(name) {
  return typeof name === 'string' && LEVEL_NAME_RE.test(name);
}

module.exports = { LEVEL_NAME_PATTERN, isValidLevelName };

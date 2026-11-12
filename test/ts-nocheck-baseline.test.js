'use strict';

// Type checking only grows: the number of server files that opt out with
// `// @ts-nocheck` may go down, never up (F-09). When you clear the header
// from a file, lower NOCHECK_BASELINE to the new count in the same change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NOCHECK_BASELINE = 45;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('no new @ts-nocheck files under src/', () => {
  const root = path.join(__dirname, '..', 'src');
  const opted = jsFiles(root).filter((f) => /^\s*\/\/\s*@ts-nocheck/m.test(fs.readFileSync(f, 'utf8').slice(0, 400)));
  assert.ok(
    opted.length <= NOCHECK_BASELINE,
    `${opted.length} files opt out of type checking (baseline ${NOCHECK_BASELINE}). Type the new module instead of adding @ts-nocheck.`
  );
  if (opted.length < NOCHECK_BASELINE) {
    assert.fail(
      `Only ${opted.length} files opt out now. Lower NOCHECK_BASELINE to ${opted.length} to lock in the gain.`
    );
  }
});

test('strictNullChecks stays on', () => {
  const tsconfig = fs.readFileSync(path.join(__dirname, '..', 'tsconfig.json'), 'utf8');
  assert.match(tsconfig, /"strictNullChecks":\s*true/);
});

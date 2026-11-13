'use strict';

// Every image the docs and README show must come from the screenshot
// generator (scripts/lib/docsShots.js), so `pnpm run docs:screenshots`
// refreshes all of them. A hand-made image silently goes stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = { images: 'docs/images', shots: 'docs/screenshots', mobile: 'docs/images/mobile' };

function generatedFiles() {
  // The list only needs base/demo inside run() callbacks, which are never called here.
  const shots = require('../scripts/lib/docsShots')({ base: 'http://x', demo: {} });
  return new Set(shots.map((s) => `${DIRS[s.dir || 'images']}/${s.file}`));
}

function referencedImages() {
  const docs = fs
    .readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('docs', f));
  const refs = new Set();
  for (const rel of ['README.md', ...docs]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const base = path.dirname(rel);
    for (const m of text.matchAll(/(?:\]\(|src=")([^)"\s]+\.png)/g)) {
      if (/^https?:/.test(m[1])) continue;
      refs.add(path.posix.normalize(path.posix.join(base, m[1])));
    }
  }
  return refs;
}

test('every image the docs reference is produced by the screenshot generator', () => {
  const generated = generatedFiles();
  const missing = [...referencedImages()].filter((f) => !generated.has(f)).sort();
  assert.deepEqual(missing, [], `add these to scripts/lib/docsShots.js: ${missing.join(', ')}`);
});

test('every generated screenshot is used by the docs', () => {
  const refs = referencedImages();
  const unused = [...generatedFiles()].filter((f) => !refs.has(f)).sort();
  assert.deepEqual(unused, [], `no doc shows these, remove them from the generator: ${unused.join(', ')}`);
});

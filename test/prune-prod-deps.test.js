'use strict';

// scripts/prune-prod-deps.js trims unused package data from the shipped
// node_modules (F-26) without touching what the panel reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prune } = require('../scripts/prune-prod-deps');

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
}

test('prune removes Bedrock version data and lucide extras, keeps Java data, bedrock/common and icons', () => {
  const nm = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const md = path.join(nm, '.pnpm', 'minecraft-data@3.117.0', 'node_modules', 'minecraft-data');
  const lu = path.join(nm, '.pnpm', 'lucide-static@1.48.0', 'node_modules', 'lucide-static');
  touch(path.join(md, 'index.js'));
  touch(path.join(md, 'minecraft-data', 'data', 'pc', '1.21.1', 'recipes.json'));
  touch(path.join(md, 'minecraft-data', 'data', 'bedrock', 'common', 'features.json'));
  touch(path.join(md, 'minecraft-data', 'data', 'bedrock', '1.20.0', 'blocks.json'));
  touch(path.join(lu, 'icons', 'play.svg'));
  touch(path.join(lu, 'package.json'));
  touch(path.join(lu, 'font', 'lucide.woff2'));
  touch(path.join(lu, 'dist', 'esm', 'index.js'));
  // pnpm's flat symlink must resolve to the same store folder.
  fs.symlinkSync(path.relative(nm, lu), path.join(nm, 'lucide-static'));

  const report = prune(nm);
  assert.deepEqual(report, { minecraftData: 1, lucide: 2 });
  assert.ok(fs.existsSync(path.join(md, 'minecraft-data', 'data', 'pc', '1.21.1', 'recipes.json')));
  assert.ok(fs.existsSync(path.join(md, 'minecraft-data', 'data', 'bedrock', 'common', 'features.json')));
  assert.ok(!fs.existsSync(path.join(md, 'minecraft-data', 'data', 'bedrock', '1.20.0')));
  assert.ok(fs.existsSync(path.join(lu, 'icons', 'play.svg')));
  assert.ok(!fs.existsSync(path.join(lu, 'font')) && !fs.existsSync(path.join(lu, 'dist')));
  fs.rmSync(nm, { recursive: true, force: true });
});

'use strict';

// Trim data the panel never reads out of a production node_modules (run by
// the Dockerfile on the tree it ships). Measured on 0.14.1: 530 MB -> ~170 MB.
//  - minecraft-data: per-version Bedrock data (~300 MB). The panel only asks
//    for Java (pc) versions; bedrock/common stays because the library's
//    feature table requires it at load.
//  - lucide-static: everything but icons/ (font/ and dist/, ~56 MB). Only the
//    SVG files are read (src/web/icons.js).
// Paths are resolved through pnpm's .pnpm store as well as a flat layout.

const fs = require('node:fs');
const path = require('node:path');

function packageDirs(nodeModules, name) {
  const dirs = [];
  const flat = path.join(nodeModules, name);
  if (fs.existsSync(flat)) dirs.push(fs.realpathSync(flat));
  const store = path.join(nodeModules, '.pnpm');
  if (fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store)) {
      if (!entry.startsWith(`${name}@`)) continue;
      const dir = path.join(store, entry, 'node_modules', name);
      if (fs.existsSync(dir)) dirs.push(fs.realpathSync(dir));
    }
  }
  return [...new Set(dirs)];
}

function removeAllBut(dir, keep) {
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir)) {
    if (keep.includes(entry)) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function prune(nodeModules) {
  const report = { minecraftData: 0, lucide: 0 };
  for (const dir of packageDirs(nodeModules, 'minecraft-data')) {
    report.minecraftData += removeAllBut(path.join(dir, 'minecraft-data', 'data', 'bedrock'), ['common']);
  }
  for (const dir of packageDirs(nodeModules, 'lucide-static')) {
    report.lucide += removeAllBut(dir, ['icons', 'package.json', 'LICENSE', 'README.md']);
  }
  return report;
}

if (require.main === module) {
  const target = path.resolve(process.argv[2] || 'node_modules');
  const report = prune(target);
  console.log(
    `[prune] removed ${report.minecraftData} Bedrock data folders and ${report.lucide} lucide-static entries`
  );
}

module.exports = { prune };

'use strict';

// Bundle + minify the client JS. Every page currently pulls /js/app.js (which
// statically imports ~13 lib/* modules) plus its own /js/pages/<name>.js source
// file - dozens of unminified round-trips per load. esbuild collapses each entry
// into one minified bundle, sharing common code through split chunks, written to
// public/dist/js/. app.js is served from there when the bundle exists (see
// src/web/app.js); the raw source stays the dev/no-build fallback.
//
// Every output name carries a content hash (pages/map-AB12CD34.js), and
// manifest.json maps each entry's source path to it ("pages/map.js" ->
// "pages/map-AB12CD34.js"). Views resolve script URLs through the `asset`
// helper, so the server can cache these files for a year: new code is a new URL.

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'public', 'js');
const pagesDir = path.join(srcDir, 'pages');
const outDir = path.join(root, 'public', 'dist', 'js');

const entryPoints = [
  path.join(srcDir, 'app.js'),
  ...fs
    .readdirSync(pagesDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(pagesDir, f)),
];

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  const result = await esbuild.build({
    entryPoints,
    outbase: srcDir,
    outdir: outDir,
    entryNames: '[dir]/[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    minify: true,
    format: 'esm',
    splitting: true,
    target: ['es2022'],
    // 'linked' emits .map files next to each bundle and references them, so the
    // minified prod bundle stays debuggable in devtools; the maps are only
    // fetched when devtools is open.
    sourcemap: 'linked',
    metafile: true,
    logLevel: 'warning',
  });

  // Entry source path (relative to public/js) -> hashed output (relative to dist/js).
  const manifest = {};
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    const src = path.relative(srcDir, path.join(root, meta.entryPoint)).split(path.sep).join('/');
    manifest[src] = path.relative(outDir, path.join(root, file)).split(path.sep).join('/');
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  let total = 0;
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    if (file.endsWith('.map')) continue;
    total += meta.bytes;
  }
  const files = Object.keys(result.metafile.outputs).filter((f) => !f.endsWith('.map')).length;
  console.log(`[build:js] ${files} files, ${(total / 1024).toFixed(0)} KB minified -> public/dist/js/`);
}

main().catch((err) => {
  console.error('[build:js] failed:', err.message);
  process.exit(1);
});

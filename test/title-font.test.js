'use strict';

// The title face ships as WOFF2, is preloaded, and has a metric-matched
// fallback so headings do not reflow when it arrives (F-19).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Press Start 2P is a preloaded WOFF2 with a size-adjusted fallback', () => {
  const woff2 = fs.readFileSync(path.join(root, 'public/fonts/PressStart2P-Regular.woff2'));
  assert.equal(woff2.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.ok(!fs.existsSync(path.join(root, 'public/fonts/PressStart2P-Regular.ttf')), 'the TTF is gone');
  const css = read('assets/css/input.css');
  assert.match(css, /src: url\('\/fonts\/PressStart2P-Regular\.woff2'\) format\('woff2'\)/);
  assert.match(
    css,
    /font-family: 'Press Start 2P Fallback';[\s\S]*?size-adjust: 166\.67%;[\s\S]*?ascent-override: 60%;/
  );
  assert.match(css, /--font-pixel: 'Press Start 2P', 'Press Start 2P Fallback'/);
  assert.match(
    read('views/partials/app-head.hbs'),
    /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/PressStart2P-Regular\.woff2" crossorigin>/
  );
});

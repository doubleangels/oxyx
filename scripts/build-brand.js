'use strict';

// Generates every Oxyx brand asset from two pixel grids, so the mark, the app
// icons, the splash screens and the logo can never drift apart:
//
//   views/partials/brand-mark.hbs      inline mark (currentColor) for the UI
//   public/favicon.svg                 tile + mark
//   public/icons/oxyx-*.png            PWA icons (any, maskable), Apple touch, badge
//   public/icons/splash/splash-*.png   iOS launch screens
//   docs/brand/oxyx-logo-{dark,light}.svg   mark + wordmark for the README/docs
//   docs/brand/oxyx-mark.svg           the tile on its own
//
// Run after changing a grid or a colour:  pnpm run build:brand
// Needs Playwright with Chromium (dev only, not a dependency of the panel):
// it rasterises the SVGs so the PNGs are pixel-exact.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// 16x16. An "O" with an "x" at its core: O-x-y-x read as a monogram.
const MARK = [
  '................',
  '................',
  '.....######.....',
  '....########....',
  '...##......##...',
  '..##.##..##.##..',
  '..##..####..##..',
  '..##...##...##..',
  '..##...##...##..',
  '..##..####..##..',
  '..##.##..##.##..',
  '...##......##...',
  '....########....',
  '.....######.....',
  '................',
  '................',
];

// 8x8 per letter, 2px strokes, in the spirit of the Press Start 2P title face.
const LETTERS = {
  O: ['.######.', '##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.######.'],
  X: ['##....##', '##....##', '.##..##.', '..####..', '..####..', '.##..##.', '##....##', '##....##'],
  Y: ['##....##', '##....##', '.##..##.', '..####..', '...##...', '...##...', '...##...', '...##...'],
};
const WORD = 'OXYX';
const LETTER_GAP = 2;

// Palette (the panel's tokens: grass-600 tile, stone-25 glyph, canvas).
const TILE = '#2f8520';
const GLYPH = '#f6f7f4';
const CANVAS = '#0e1113';
const INK_DARK = '#1c2024';

/** One <path> for a grid: each horizontal run of '#' becomes one rectangle. */
function gridPath(rows, dx = 0, dy = 0) {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (row[x] !== '#') {
        x++;
        continue;
      }
      let len = 0;
      while (row[x + len] === '#') len++;
      d += `M${x + dx} ${y + dy}h${len}v1h-${len}z`;
      x += len;
    }
  });
  return d;
}

const markPath = gridPath(MARK);

/** The tile: rounded square, a darker bottom lip (the UI's pressed-block look), the mark. */
function tileSvg({ bleed = false, size } = {}) {
  const dim = size ? ` width="${size}" height="${size}"` : '';
  if (bleed) {
    // Maskable / Apple touch: full-bleed colour, mark scaled into the safe zone.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"${dim} shape-rendering="crispEdges"><rect width="16" height="16" fill="${TILE}"/><g transform="translate(2.4 2.4) scale(0.7)"><path fill="${GLYPH}" d="${markPath}"/></g></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"${dim} shape-rendering="crispEdges"><defs><clipPath id="t"><rect width="16" height="16" rx="3.5"/></clipPath></defs><g clip-path="url(#t)"><rect width="16" height="16" fill="${TILE}"/><rect y="14.5" width="16" height="1.5" fill="#000" fill-opacity="0.22"/></g><path fill="${GLYPH}" d="${markPath}"/></svg>`;
}

/** Monochrome mark on transparent: Android draws notification badges from alpha only. */
function badgeSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 12 12" width="${size}" height="${size}" shape-rendering="crispEdges"><path fill="#fff" d="${markPath}"/></svg>`;
}

/** Mark tile + pixel wordmark. `ink` colours the word. */
function logoSvg(ink) {
  const letterW = 8;
  const wordW = WORD.length * letterW + (WORD.length - 1) * LETTER_GAP;
  const word = [...WORD].map((ch, i) => gridPath(LETTERS[ch], 22 + i * (letterW + LETTER_GAP), 4)).join('');
  const w = 22 + wordW;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 16" width="${w * 12}" height="${16 * 12}" shape-rendering="crispEdges" role="img" aria-label="Oxyx"><defs><clipPath id="t"><rect width="16" height="16" rx="3.5"/></clipPath></defs><g clip-path="url(#t)"><rect width="16" height="16" fill="${TILE}"/><rect y="14.5" width="16" height="1.5" fill="#000" fill-opacity="0.22"/></g><path fill="${GLYPH}" d="${markPath}"/><path fill="${ink}" d="${word}"/></svg>`;
}

function write(rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  console.log(`[brand] ${rel}`);
}

// iOS launch screens: canvas colour, tile centred at ~30% of the short side.
const SPLASH = [
  [750, 1334],
  [828, 1792],
  [1125, 2436],
  [1170, 2532],
  [1179, 2556],
  [1206, 2622],
  [1242, 2208],
  [1242, 2688],
  [1284, 2778],
  [1290, 2796],
  [1320, 2868],
  [1488, 2266],
  [1536, 2048],
  [1620, 2160],
  [1640, 2360],
  [1668, 2388],
  [2048, 2732],
];

async function rasterise() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Install it (with Chromium) to rasterise the PNG icons.');
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function png(rel, svg, w, h, background = null) {
    await page.setViewportSize({ width: w, height: h });
    const bg = background ? `background:${background};` : 'background:transparent;';
    await page.setContent(
      `<html><body style="margin:0;${bg}width:${w}px;height:${h}px;display:grid;place-items:center">${svg}</body></html>`
    );
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await page.screenshot({ path: abs, omitBackground: !background, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(`[brand] ${rel}`);
  }
  await png('public/icons/oxyx-192.png', tileSvg({ size: 192 }), 192, 192);
  await png('public/icons/oxyx-512.png', tileSvg({ size: 512 }), 512, 512);
  await png('public/icons/oxyx-maskable-192.png', tileSvg({ bleed: true, size: 192 }), 192, 192);
  await png('public/icons/oxyx-maskable-512.png', tileSvg({ bleed: true, size: 512 }), 512, 512);
  await png('public/icons/oxyx-apple-touch.png', tileSvg({ bleed: true, size: 180 }), 180, 180);
  await png('public/icons/oxyx-badge-96.png', badgeSvg(96), 96, 96);
  for (const [w, h] of SPLASH) {
    // Whole pixels per grid cell keep the edges crisp.
    const tile = Math.round((Math.min(w, h) * 0.3) / 16) * 16;
    await png(`public/icons/splash/splash-${w}x${h}.png`, tileSvg({ size: tile }), w, h, CANVAS);
  }
  await browser.close();
}

async function main() {
  write(
    'views/partials/brand-mark.hbs',
    `{{! The Oxyx mark, generated by scripts/build-brand.js (edit the grid there).
    Inline so it takes currentColor. Param: class (sizing). }}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="{{default class 'size-7'}}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path fill="currentColor" d="${markPath}"/></svg>
`
  );
  write('public/favicon.svg', `${tileSvg()}\n`);
  write('docs/brand/oxyx-mark.svg', `${tileSvg({ size: 256 })}\n`);
  write('docs/brand/oxyx-logo-dark.svg', `${logoSvg(GLYPH)}\n`);
  write('docs/brand/oxyx-logo-light.svg', `${logoSvg(INK_DARK)}\n`);
  if (!process.argv.includes('--svg-only')) await rasterise();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[brand] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { MARK, LETTERS, gridPath, tileSvg, logoSvg };

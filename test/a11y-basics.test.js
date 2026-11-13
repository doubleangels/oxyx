'use strict';

// Keyboard and screen-reader basics in the shell and tables (F-24, F-25).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./helpers/app');

const root = path.join(__dirname, '..');

test('every page in the main layout starts with a skip link to #main', async (t) => {
  await app.start();
  t.after(() => app.stop());
  const cookie = await app.adminCookie();
  const page = await app.req('GET', '/', { cookie, headers: { Accept: 'text/html' } });
  const body = page.text.slice(page.text.indexOf('<body'));
  const first = /<a\b[^>]*>/.exec(body)[0];
  assert.match(first, /href="#main"/, 'the first link on the page is the skip link');
  assert.match(page.text, /<main id="main" tabindex="-1"/);
});

test('every table header cell declares its scope', () => {
  const views = [];
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.hbs')) views.push(p);
    });
  walk(path.join(root, 'views'));
  const missing = views.flatMap((p) =>
    (fs.readFileSync(p, 'utf8').match(/<th(?=[\s>])[^>]*>/g) || [])
      .filter((tag) => !/\bscope="(col|row)"/.test(tag))
      .map((tag) => `${path.relative(root, p)}: ${tag}`)
  );
  assert.deepEqual(missing, []);
});

test('text fields get the same focus-visible outline as buttons', () => {
  const css = fs.readFileSync(path.join(root, 'assets/css/input.css'), 'utf8');
  const input = /\n {2}\.input \{[\s\S]*?\}/.exec(css)[0];
  assert.match(input, /focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus/);
});

'use strict';

// The auto-escaping html`` tag in public/js/lib/format.js (F-14).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let html;
let raw;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lib', 'format.js'), 'utf8');
  ({ html, raw } = await import(`data:text/javascript,${encodeURIComponent(src)}`));
});

test('every interpolated value is escaped', () => {
  const name = `<img src=x onerror="alert('1')">&`;
  assert.equal(
    String(html`<li title="${name}">${name}</li>`),
    '<li title="&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;</li>'
  );
});

test('nested html and raw() are not double-escaped; arrays join; null is empty', () => {
  const items = ['<a>', 'b'];
  assert.equal(
    String(
      html`<ul>
        ${items.map((i) => html`<li>${i}</li>`)}
      </ul>`
    ),
    '<ul><li>&lt;a&gt;</li><li>b</li></ul>'
  );
  assert.equal(String(html`${raw('<svg></svg>')}${null}${undefined}${0}`), '<svg></svg>0');
  assert.equal(String(html`${['<x>', html`<y />`]}`), '&lt;x&gt;<y/>');
});

test('the result works anywhere a string does (innerHTML assignment stringifies)', () => {
  const el = {};
  el.innerHTML = `${html`<b>${'&'}</b>`}`;
  assert.equal(el.innerHTML, '<b>&amp;</b>');
});

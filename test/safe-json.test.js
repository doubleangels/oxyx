'use strict';

// One corrupt JSON column must not 500 every page (F-08).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const { safeJsonParse } = require('../src/utils/safeJson');

let cookie;
test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
});
test.after(() => app.stop());

test('safeJsonParse returns the fallback for empty, invalid or wrong-shaped values', () => {
  assert.deepEqual(safeJsonParse('{"a":1}', {}), { a: 1 });
  assert.deepEqual(safeJsonParse('[1]', []), [1]);
  for (const bad of [null, undefined, '', '{nope', '5', 'null', '"str"']) assert.deepEqual(safeJsonParse(bad, {}), {});
  assert.deepEqual(safeJsonParse('{"a":1}', []), [], 'object where an array belongs');
  assert.deepEqual(safeJsonParse('[1]', {}), {}, 'array where an object belongs');
  let flagged = 0;
  safeJsonParse('{nope', {}, { where: 't', onBad: () => flagged++ });
  safeJsonParse('{}', {}, { where: 't', onBad: () => flagged++ });
  assert.equal(flagged, 1);
});

test('invalid JSON in env_json still renders the dashboard and the server page, with a notice', async () => {
  const id = app.seedServer('srv_badjson');
  db.run("UPDATE servers SET env_json = '{not json', tags_json = 'x', extra_ports_json = '[' WHERE id = ?", id);
  const html = { cookie, headers: { Accept: 'text/html' } };
  const dash = await app.req('GET', '/', html);
  assert.equal(dash.status, 200);
  assert.ok(dash.text.includes('Test Server'), 'the server still lists in the sidebar');
  const page = await app.req('GET', `/servers/${id}`, html);
  assert.equal(page.status, 200);
  assert.match(page.text, /Some saved settings could not be read/);
  const server = require('../src/services/servers').getServer(id);
  assert.deepEqual(server.env, {});
  assert.deepEqual(server.damagedColumns.sort(), ['env_json', 'extra_ports_json', 'tags_json']);
});

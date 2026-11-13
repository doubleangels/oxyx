'use strict';

// The public status pages get their own per-IP limiter and a short cache (F-16).

require('./helpers/env');
process.env.RATE_LIMIT_STATUS_PER_MIN = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const statusPage = require('../src/integrations/statusPage');

test.before(async () => {
  await app.start();
  await app.adminCookie();
  app.seedServer('srv_rl');
  statusPage.setStatusPage('srv_rl', { enabled: true, slug: 'limited' });
});
test.after(() => app.stop());

test('a 200 status page is cacheable for a few seconds, and a flood from one IP gets 429', async () => {
  const first = await app.req('GET', '/status/limited', { headers: { Accept: 'text/html' } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=5');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await app.req('GET', '/status/nope-' + i)).status);
  assert.ok(statuses.includes(429), `limited after 5 per minute: ${statuses}`);
  assert.equal(statuses.at(-1), 429);
});

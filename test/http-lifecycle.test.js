'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { configureHttpTimeouts } = require('../src/web/httpLifecycle');

test('configureHttpTimeouts lifts the whole-request ceiling but keeps the header guard (F-05)', () => {
  const srv = http.createServer();
  assert.equal(srv.requestTimeout, 300_000, "Node's default this guards against");
  configureHttpTimeouts(srv);
  assert.equal(srv.requestTimeout, 0);
  assert.equal(srv.headersTimeout, 60_000);
});

'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

test('the panel database runs WAL with synchronous=NORMAL (F-21)', () => {
  assert.equal(String(Object.values(db.get('PRAGMA journal_mode'))[0]).toLowerCase(), 'wal');
  assert.equal(Object.values(db.get('PRAGMA synchronous'))[0], 1, '1 = NORMAL');
  assert.doesNotThrow(() => db.exec('PRAGMA optimize'));
});

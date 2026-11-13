'use strict';

// The post-boot guard exits on an uncaught exception by default (F-07), keeps
// running when told to, and leaves a rejection logged but alive.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guards = path.join(__dirname, '..', 'src', 'runtimeGuards.js');

function run(fault, extraEnv = {}) {
  const script = `
    require(${JSON.stringify(guards)}).installRuntimeGuards({ exit: (c) => process.exit(c) });
    setTimeout(() => { ${fault} }, 10);
    setTimeout(() => { process.stdout.write('survived'); process.exit(0); }, 300);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('a throw in a timer exits the process with 1 by default', () => {
  const r = run("throw new Error('boom');");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /survived/);
});

test('OXYX_KEEP_ALIVE_ON_FATAL=1 keeps the old log-and-continue', () => {
  const r = run("throw new Error('boom');", { OXYX_KEEP_ALIVE_ON_FATAL: '1' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /survived/);
});

test('an unhandled rejection is logged and the panel stays up, unless OXYX_EXIT_ON_FATAL=1', () => {
  const alive = run("Promise.reject(new Error('nope'));");
  assert.equal(alive.status, 0);
  assert.match(alive.stdout, /survived/);
  const dies = run("Promise.reject(new Error('nope'));", { OXYX_EXIT_ON_FATAL: '1' });
  assert.equal(dies.status, 1);
});

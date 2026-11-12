'use strict';

// Boots the real panel (src/server.js) in a child process against a throwaway
// data folder, then sends SIGTERM: it must exit 0 well inside Docker's 10 s
// stop timeout and leave no pending WAL content (F-06).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(port, child, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`panel exited early with ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('panel did not start listening');
}

test('SIGTERM shuts the panel down with exit 0 in under 10 seconds and an empty WAL', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-shutdown-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PANEL_PORT: String(port),
      PANEL_HOST: '127.0.0.1',
      DOCKER_HOST: 'tcp://127.0.0.1:1', // unreachable on purpose: no daemon in tests
      LOG_LEVEL: 'silent',
    },
    stdio: 'ignore',
  });
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  await waitForHttp(port, child);

  // A write so the WAL has something in it before shutdown.
  await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'supersecret123' }),
  });
  // Hold a keep-alive connection open: shutdown must not wait on it.
  const idle = net.connect(port, '127.0.0.1');
  await new Promise((r) => idle.once('connect', r));
  idle.write(`GET /login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
  await new Promise((r) => idle.once('data', r));

  const started = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.once('exit', resolve));
  idle.destroy();
  const took = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(took < 10000, `exited in ${took} ms`);
  const wal = path.join(dataDir, 'panel.db-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'no WAL content left behind');
  assert.ok(fs.statSync(path.join(dataDir, 'panel.db')).size > 0);
});

'use strict';
/* global document -- page.evaluate() callbacks run in the browser */

// Regenerates the documentation screenshots against a throwaway demo panel.
//
//   pnpm run docs:screenshots            every shot
//   pnpm run docs:screenshots dashboard  only shots whose file name matches
//
// Boots the real Express app in-process on a temporary data folder, seeds a
// believable fleet (servers, players, history, backups, mods, worlds, ...),
// and stubs only the Docker daemon: container status, live stats, console
// output and the daemon probe come from the demo data instead of a socket.
// Playwright (with Chromium) drives the pages at 1440x900, device scale 2,
// the size every image in docs/ uses. Needs Playwright with Chromium, which is
// not a panel dependency: with a global install, run it as
//   NODE_PATH="$(npm root -g)" pnpm run docs:screenshots

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oxyx-docs-'));
process.env.DATA_DIR = DATA;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'docs-screenshots-secret-0123456789';
process.env.LOG_LEVEL = 'silent';
process.env.DOCKER_HOST = 'tcp://127.0.0.1:1'; // never reach a real daemon
process.env.TZ = 'UTC';

const demo = require('./lib/docsDemo');

// ---- Docker stubs: patched before any route module destructures them ----
const connect = require('../src/docker/connect');
connect.checkDocker = async () => ({
  available: true,
  installed: true,
  version: '29.1.3',
  os: 'Ubuntu 24.04.3 LTS',
  ncpu: 16,
  memTotal: 64 * 1024 ** 3,
  isDockerDesktop: false,
  error: null,
});
const containers = require('../src/docker/containers');
containers.inspectStatus = async (serverId) => demo.inspect(serverId);
// execCapture resolves the output string; execCaptureChecked adds the exit code.
containers.execCapture = async (serverId, cmd) => demo.exec(serverId, cmd).stdout;
containers.execCaptureChecked = async (serverId, cmd) => demo.exec(serverId, cmd);
containers.publishedHostPorts = async () => new Set();
const logs = require('../src/docker/logs');
logs.fetchLogs = async (serverId) => demo.consoleText(serverId);
const liveCache = require('../src/services/liveCache');
liveCache.get = (serverId) => demo.live(serverId);
liveCache.getAll = () => demo.liveAll();

const OUT = {
  shots: path.join(ROOT, 'docs', 'screenshots'),
  images: path.join(ROOT, 'docs', 'images'),
};

async function main() {
  const filter = process.argv[2] || '';
  const { chromium } = require('playwright');
  const { migrate } = require('../src/db/migrate');
  migrate({ snapshot: false });
  const { createApp } = require('../src/web/app');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  require('../src/ws').attachWebSockets(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    timezoneId: 'UTC',
    locale: 'en-US',
  };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const shots = require('./lib/docsShots')({ base, demo });
  let seeded = false;
  let done = 0;
  const failed = [];
  for (const shot of shots) {
    if (filter && !shot.file.includes(filter)) continue;
    const target = path.join(OUT[shot.dir || 'images'], shot.file);
    // Shots marked firstRun come first in the list and need an empty panel.
    if (!shot.firstRun && !seeded) {
      await demo.seed();
      await demo.signIn(page, base);
      seeded = true;
    }
    try {
      // fresh: a separate, signed-out browser context (sign-in and setup pages).
      const freshContext = shot.fresh ? await browser.newContext(contextOptions) : null;
      const p = freshContext ? await freshContext.newPage() : page;
      if (shot.viewport) await p.setViewportSize(shot.viewport);
      await shot.run(p);
      await p.evaluate(() => document.fonts && document.fonts.ready);
      await p.waitForTimeout(shot.settle ?? 350);
      await p.screenshot({ path: target, fullPage: Boolean(shot.fullPage), animations: 'disabled' });
      if (shot.viewport) await p.setViewportSize({ width: 1440, height: 900 });
      if (freshContext) await freshContext.close();
      if (shot.after) await shot.after(page);
      done += 1;
      console.log(`[shots] ${path.relative(ROOT, target)}`);
    } catch (err) {
      failed.push(`${shot.file}: ${err.message.split('\n')[0]}`);
      console.error(`[shots] FAILED ${shot.file}: ${err.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`[shots] ${done} written, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

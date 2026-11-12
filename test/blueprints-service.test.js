'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ZipArchive } = require('archiver');
const app = require('./helpers/app');
const { dataPath } = require('../src/storage/pathGuard');
const bp = require('../src/blueprints');

test.before(async () => {
  await app.start();
  await app.adminCookie();
});
test.after(async () => {
  await app.stop();
});

async function writeZip(name, entries) {
  const abs = dataPath('blueprints', name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(abs);
    const zip = new ZipArchive();
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [n, content] of Object.entries(entries)) zip.append(content, { name: n });
    zip.finalize();
  });
  return abs;
}

const manifest = (over = {}) => ({
  msm: 1,
  name: 'Test',
  createdAt: new Date().toISOString(),
  panelVersion: '0.1',
  identity: { name: 'Test' },
  config: { type: 'PAPER', mcVersion: '1.21.1', env: {} },
  resources: { heapMb: 1024, containerMemoryMb: 1536, cpus: 2, diskQuotaGb: 10 },
  overlay: [],
  configFiles: [],
  ...over,
});

test('seedStarters installs two built-ins once, then is a no-op', async () => {
  const first = await bp.seedStarters();
  assert.equal(first.seeded, 2);
  assert.deepEqual(await bp.seedStarters(), { seeded: 0 });
  const list = bp.listBlueprints();
  assert.equal(list.filter((b) => b.builtin).length, 2);
  assert.ok(list.every((b) => b.type && b.mcVersion));
});

test('getBlueprint / getBlueprintPath / deleteBlueprint', async () => {
  const [one] = bp.listBlueprints();
  assert.equal(bp.getBlueprint(one.id).id, one.id);
  assert.equal(bp.getBlueprint('bp_nope'), null);
  assert.ok(bp.getBlueprintPath(one.id).endsWith(one.filename));
  assert.throws(() => bp.getBlueprintPath('bp_nope'), { status: 404 });
  const r = await bp.deleteBlueprint(one.id, { actor: 'tester' });
  assert.equal(r.freedBytes, one.size_bytes);
  assert.equal(bp.getBlueprint(one.id), null);
  await assert.rejects(bp.deleteBlueprint(one.id), { status: 404 });
});

test('blueprintVisibleTo shows source-less blueprints to everyone', () => {
  assert.equal(bp.blueprintVisibleTo({}, { manifest: {} }), true);
  assert.equal(bp.blueprintVisibleTo({}, null), true);
});

test('importPreview rejects missing, non-JSON, and invalid manifests', async () => {
  await assert.rejects(bp.importPreview(await writeZip('a.zip', { 'x.txt': 'hi' })), /manifest\.json is missing/);
  await assert.rejects(bp.importPreview(await writeZip('b.zip', { 'manifest.json': '{nope' })), /not valid JSON/);
  await assert.rejects(bp.importPreview(await writeZip('c.zip', { 'manifest.json': '{"a":1}' })), /not valid/);
});

test('importPreview rejects config paths that escape the server dir', async () => {
  const zip = await writeZip('d.zip', { 'manifest.json': JSON.stringify(manifest({ configFiles: ['../evil'] })) });
  await assert.rejects(bp.importPreview(zip), { status: 400, message: /outside the server folder/ });
});

test('importBlueprint rejects an overlay filename that walks out of the payload (F-27)', async () => {
  const before = require('../src/db').get('SELECT COUNT(*) AS n FROM servers').n;
  const m = manifest({
    embedFiles: true,
    overlay: [{ name: 'Sneaky', kind: 'mod', filename: '../../../../panel.db' }],
  });
  const zip = await writeZip('f27a.zip', {
    'manifest.json': JSON.stringify(m),
    'payload/overlay/placeholder.jar': 'x',
  });
  await assert.rejects(bp.importBlueprint(zip, {}, { actor: 'tester' }), { status: 400 });
  for (const filename of ['/etc/passwd', 'a\\..\\b', '..', '.']) {
    const z = await writeZip('f27b.zip', {
      'manifest.json': JSON.stringify(manifest({ overlay: [{ name: 'X', kind: 'mod', filename }] })),
    });
    await assert.rejects(bp.importPreview(z), { status: 400 }, filename);
  }
  assert.equal(require('../src/db').get('SELECT COUNT(*) AS n FROM servers').n, before, 'no server created');
});

test('importBlueprint rejects a nested traversal in configFiles (F-27)', async () => {
  for (const rel of ['config/../../../panel.db', 'config//x', '/abs/path', 'config/./x']) {
    const zip = await writeZip('f27c.zip', { 'manifest.json': JSON.stringify(manifest({ configFiles: [rel] })) });
    await assert.rejects(bp.importBlueprint(zip, {}, { actor: 'tester' }), { status: 400 }, rel);
  }
});

test('importPreview collects warnings', async () => {
  const m = manifest({
    config: { type: 'WEIRD', mcVersion: '1.7.10', env: {} },
    embedFiles: true,
    world: true,
    pack: { platform: 'curseforge', projectRef: 'x', versionId: '1' },
    overlay: [
      { name: 'NoSrc', kind: 'mod', filename: 'a.jar' },
      { name: 'Embedded', kind: 'mod', filename: 'b.jar', sha256: 'a'.repeat(64) },
    ],
  });
  const zip = await writeZip('e.zip', {
    'manifest.json': JSON.stringify(m),
    'payload/overlay/b.jar': 'jar',
  });
  const r = await bp.importPreview(zip);
  const w = r.warnings.join('\n');
  assert.match(w, /Unknown server type "WEIRD"/);
  assert.match(w, /very old/);
  assert.match(w, /1 embedded custom file/);
  assert.match(w, /"NoSrc" has no source URL/);
  assert.match(w, /"NoSrc" carries no hash/);
  assert.match(w, /no world payload/);
  assert.match(w, /CurseForge/);
  assert.equal(r.entries.count, 2);
  assert.equal(r.entries.payloadBytes, 3);
});

test('exportBlueprint round-trips a seeded server and hides secrets', async () => {
  const id = app.seedServer('srv_bpexp');
  const db = require('../src/db');
  db.run('UPDATE servers SET env_json = ? WHERE id = ?', JSON.stringify({ MOTD: 'hi', RCON_PASSWORD: 'secret' }), id);
  const dir = dataPath('servers', id);
  fs.mkdirSync(path.join(dir, 'config', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=x\n');
  fs.writeFileSync(path.join(dir, 'config', 'sub', 'a.toml'), 'a=1\n');

  await assert.rejects(bp.exportBlueprint('srv_missing'), { status: 404 });
  const row = await bp.exportBlueprint(id, {}, { actor: 'tester' });
  const got = bp.getBlueprint(row.id);
  assert.equal(got.manifest.sourceServerId, id);
  assert.deepEqual(got.manifest.configFiles.sort(), ['config/sub/a.toml', 'server.properties']);
  assert.ok(!JSON.stringify(got.manifest).includes('secret'));
  const preview = await bp.importPreview(bp.getBlueprintPath(row.id));
  assert.equal(preview.manifest.name, 'Test Server');
  assert.deepEqual(
    bp
      .listBlueprintsFor({ role: 'admin', id: 1 })
      .map((b) => b.id)
      .includes(row.id),
    true
  );
});

test('imported env goes through the same checks as the wizard (F-31)', async () => {
  const db = require('../src/db');
  const before = db.get('SELECT COUNT(*) AS n FROM servers').n;
  const bad = await writeZip('f31a.zip', {
    'manifest.json': JSON.stringify(
      manifest({ config: { type: 'PAPER', mcVersion: '1.21.1', env: { LEVEL: '../..' } } })
    ),
  });
  await assert.rejects(bp.importBlueprint(bad, {}, { actor: 'tester' }), { status: 400, message: /World Save Name/ });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM servers').n, before, 'refused before a server row exists');

  // The panel's env denylist (SERVER_PORT, LOAD_ENV_FROM_FILE, …) runs in assembleEnv for every
  // server, blueprint or not; servers-core.test.js covers it.
});

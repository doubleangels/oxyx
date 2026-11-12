'use strict';

// A world (level) folder name comes from the LEVEL env or server.properties,
// both user-editable. It must never reach outside the server's own folder.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const { dataPath, serverPath } = require('../src/storage/pathGuard');

const containers = require('../src/docker/containers');
containers.inspectStatus = async () => ({ exists: false });
const backups = require('../src/services/backups');
backups.createBackupUnguarded = async () => {};

const worlds = require('../src/services/worlds');
const inventory = require('../src/services/inventory');
const blueprints = require('../src/blueprints');
const servers = require('../src/services/servers');
const { isValidLevelName } = require('../src/utils/levelName');

let port = 27100;
function mkServer(id, env = {}) {
  db.run(
    `INSERT INTO servers (id, display_name, type, mc_version, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, status, env_json)
     VALUES (?, ?, 'PAPER', '1.21.1', ?, ?, 'x', 1024, 1536, 'stopped', ?)`,
    id,
    `Srv ${id}`,
    port,
    port + 1000,
    JSON.stringify(env)
  );
  port++;
  fs.mkdirSync(dataPath('servers', id), { recursive: true });
  return id;
}

// The victim: another server's world, with a marker that must survive.
const VICTIM = mkServer('srv_victim');
const marker = dataPath('servers', VICTIM, 'world', 'level.dat');
fs.mkdirSync(dataPath('servers', VICTIM, 'world', 'playerdata'), { recursive: true });
fs.writeFileSync(marker, 'victim');

test('isValidLevelName accepts plain names and refuses paths', () => {
  for (const ok of ['world', 'My World', 'world-2', 'x'.repeat(64)]) assert.equal(isValidLevelName(ok), true, ok);
  for (const bad of ['', '..', '.', '.hidden', '../x', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(65), null, 5]) {
    assert.equal(isValidLevelName(bad), false, String(bad));
  }
});

test('serverPath refuses a segment that leaves the server folder but stays in the data root', () => {
  assert.throws(() => serverPath('srv_a', '..', VICTIM, 'world'), { status: 400 });
  assert.throws(() => serverPath('srv_a', '../..'), { status: 400 });
  assert.ok(serverPath('srv_a', 'world', 'level.dat').endsWith('level.dat'));
});

for (const [label, setup] of [
  [
    'level-name=../srv_victim/world',
    (id) => fs.writeFileSync(dataPath('servers', id, 'server.properties'), `level-name=../${VICTIM}/world\n`),
  ],
  [
    'LEVEL=../..',
    (id) => db.run('UPDATE servers SET env_json = ? WHERE id = ?', JSON.stringify({ LEVEL: '../..' }), id),
  ],
]) {
  test(`${label}: world and blueprint operations refuse with 400 and touch nothing outside`, async () => {
    const id = mkServer(`srv_att${port}`);
    setup(id);
    const server = servers.getServer(id);
    const blueprintsBefore = db.get('SELECT COUNT(*) AS n FROM blueprints').n;
    assert.throws(() => worlds.activeLevelName(server), { status: 400 });
    await assert.rejects(worlds.extractFromServer(id, { actor: 'tester' }), { status: 400 });
    await assert.rejects(worlds.resetWorld(id, { backup: false, actor: 'tester' }), { status: 400 });
    await assert.rejects(
      Promise.resolve().then(() => inventory.listPlayersWithData(id)),
      { status: 400 }
    );
    await assert.rejects(blueprints.exportBlueprint(id, { name: 'x', includeWorld: true }, { actor: 'tester' }), {
      status: 400,
    });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'victim', 'the other server is untouched');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM blueprints').n, blueprintsBefore, 'no blueprint written');
  });
}

test('saving an invalid World Save Name is refused', () => {
  const id = mkServer('srv_save');
  assert.throws(() => servers.updateServer(id, { env: { LEVEL: '../srv_victim/world' } }), {
    status: 400,
    message: /World Save Name is not valid/,
  });
  assert.doesNotThrow(() => servers.updateServer(id, { env: { LEVEL: 'other world' } }));
  assert.doesNotThrow(() => servers.updateServer(id, { env: { LEVEL: '' } }), 'blank clears the key');
});

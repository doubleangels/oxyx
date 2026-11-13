'use strict';

// Demo fleet for scripts/docs-screenshots.js: a believable panel seeded into a
// throwaway data folder, plus the answers the Docker stubs give. Deterministic
// (seeded RNG, fixed clock offsets) so re-running produces the same images.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Seeded RNG first: every helper below (and fakePlayers) draws from it.
let rngState = 0x0c5a1e;
Math.random = () => {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const ADMIN = { username: 'alex', password: 'demo-password-123' };
const DEMO_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/demo-this-device';
const MB = 1024 * 1024;
const GB = 1024 * MB;

const SERVERS = [
  {
    id: 'srv_harbor',
    name: 'Harbor SMP',
    type: 'PAPER',
    mc: '1.21.4',
    icon: 'grass',
    accent: '#3fa62b',
    tags: ['smp', 'survival', 'friends'],
    description: 'The long-running survival world. Whitelisted, weekly backups, no griefing.',
    status: 'running',
    heap: 4096,
    mem: 5120,
    cpus: 4,
    world: 3.4 * GB,
    online: ['Steve_Builds', 'MossyMiner', 'RedstoneRae', 'Kitsune42', 'PixelPiper'],
    motd: 'Harbor SMP: survival with friends',
  },
  {
    id: 'srv_fabric',
    name: 'Fabric Playground',
    type: 'FABRIC',
    mc: '1.21.1',
    icon: 'portal',
    accent: '#9a5cc6',
    tags: ['modded', 'test'],
    description: 'Performance mods and shaders, for trying new builds before they go live.',
    status: 'running',
    heap: 6144,
    mem: 7168,
    cpus: 4,
    world: 1.1 * GB,
    online: ['Kitsune42', 'EnderEcho'],
    motd: 'Fabric Playground',
  },
  {
    id: 'srv_emerald',
    name: 'Emerald Depths',
    type: 'NEOFORGE',
    mc: '1.21.1',
    icon: 'diamond',
    accent: '#21a7ab',
    tags: ['modded', 'survival'],
    description: 'Tech and exploration modpack for the weekend group.',
    status: 'stopped',
    heap: 8192,
    mem: 10240,
    cpus: 6,
    world: 5.7 * GB,
    online: [],
    motd: 'Emerald Depths',
  },
  {
    id: 'srv_molten',
    name: 'Molten Hideout',
    type: 'PURPUR',
    mc: '1.21.4',
    icon: 'sword',
    accent: '#e5484d',
    tags: ['pvp'],
    description: 'Arena PvP with kits.',
    status: 'stopped',
    heap: 2048,
    mem: 3072,
    cpus: 2,
    world: 0.6 * GB,
    online: [],
    motd: 'Molten Hideout PvP',
  },
  {
    id: 'srv_redstone',
    name: 'Redstone Overlook',
    type: 'VANILLA',
    mc: '1.21.4',
    icon: 'creeper',
    accent: '#3fa62b',
    tags: ['creative'],
    description: 'Creative flat world for redstone contraptions.',
    status: 'stopped',
    heap: 2048,
    mem: 3072,
    cpus: 2,
    world: 0.4 * GB,
    online: [],
    motd: 'Redstone Overlook (creative)',
  },
  {
    id: 'srv_nexus',
    name: 'Shattered Nexus',
    type: 'FORGE',
    mc: '1.20.1',
    icon: 'tnt',
    accent: '#e99417',
    tags: ['modded', 'hardcore'],
    description: 'Hardcore modded challenge run.',
    status: 'crashed',
    heap: 6144,
    mem: 7168,
    cpus: 4,
    world: 2.2 * GB,
    online: [],
    motd: 'Shattered Nexus',
  },
];

const byId = Object.fromEntries(SERVERS.map((s) => [s.id, s]));
const isUp = (s) => s && s.status === 'running';
const ago = (minutes) => new Date(Date.now() - minutes * 60000);
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------------------
// Answers for the Docker stubs

function inspect(serverId) {
  const s = byId[serverId];
  if (!s) return { exists: false };
  const up = isUp(s);
  return {
    exists: true,
    status: s.status === 'crashed' ? 'crashed' : up ? 'running' : 'stopped',
    health: up ? 'healthy' : null,
    exitCode: s.status === 'crashed' ? 1 : 0,
    startedAt: up ? ago(s.id === 'srv_harbor' ? 3 * 24 * 60 + 260 : 95).toISOString() : null,
    finishedAt: up ? null : ago(600).toISOString(),
    oomKilled: false,
    containerId: `c0ffee${serverId.slice(4)}`,
    imageId: 'sha256:demo',
  };
}

function live(serverId) {
  const s = byId[serverId];
  const empty = {
    stats: null,
    players: null,
    startedAt: null,
    phase: null,
    upConfirmed: false,
    perf: null,
    perfSupported: true,
  };
  if (!isUp(s)) return empty;
  const memUsed = s.id === 'srv_harbor' ? 3.1 * GB : 4.4 * GB;
  return {
    stats: {
      cpuPct: s.id === 'srv_harbor' ? 38 : 22,
      memUsedBytes: memUsed,
      memLimitBytes: s.mem * MB,
      netRx: 182 * MB,
      netTx: 64 * MB,
      at: Date.now(),
    },
    players: { online: s.online.length, max: 20, names: s.online, at: Date.now() },
    startedAt: inspect(serverId).startedAt,
    phase: null,
    upConfirmed: true,
    perf: {
      tps1: 19.97,
      tps5: 19.94,
      tps15: 19.9,
      mspt: s.id === 'srv_harbor' ? 21.4 : 14.8,
      source: 'paper',
      at: Date.now(),
    },
    perfSupported: true,
  };
}

function liveAll() {
  return Object.fromEntries(SERVERS.map((s) => [s.id, live(s.id)]));
}

function consoleText(serverId) {
  const s = byId[serverId];
  const t = (m) => ago(m).toISOString().slice(11, 19);
  if (!s) return '';
  const lines = [
    `[${t(96)} INFO]: Starting minecraft server version ${s.mc}`,
    `[${t(96)} INFO]: Loading properties`,
    `[${t(96)} INFO]: Default game type: SURVIVAL`,
    `[${t(96)} INFO]: Preparing level "world"`,
    `[${t(95)} INFO]: Preparing start region for dimension minecraft:overworld`,
    `[${t(95)} INFO]: Done (11.284s)! For help, type "help"`,
    `[${t(95)} INFO]: Starting remote control listener`,
    `[${t(95)} INFO]: RCON running on 0.0.0.0:25575`,
  ];
  if (isUp(s)) {
    for (const [i, name] of s.online.entries()) {
      lines.push(`[${t(80 - i * 9)} INFO]: ${name} joined the game`);
    }
    lines.push(
      `[${t(40)} INFO]: <MossyMiner> anyone want to help with the harbor bridge?`,
      `[${t(39)} INFO]: <Steve_Builds> on my way, bringing spruce`,
      `[${t(31)} INFO]: RedstoneRae has made the advancement [Hot Stuff]`,
      `[${t(22)} WARN]: Can't keep up! Is the server overloaded? Running 2034ms or 40 ticks behind`,
      `[${t(12)} INFO]: [Rcon: Saved the game]`,
      `[${t(4)} INFO]: <Kitsune42> the new farm is done :)`
    );
  }
  return lines.join('\n') + '\n';
}

function exec(serverId, cmd) {
  const s = byId[serverId];
  const joined = cmd.join(' ');
  if (/rcon-cli.*\blist\b/.test(joined)) {
    const names = (s && s.online) || [];
    return { stdout: `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`, exitCode: 0 };
  }
  if (/rcon-cli.*\b(tps|mspt)\b/.test(joined)) {
    return { stdout: 'TPS from last 1m, 5m, 15m: 20.0, 19.9, 19.9', exitCode: 0 };
  }
  // World Controls reads these, phrased as a 1.21 server answers them.
  const args = cmd.slice(1).filter((a) => a !== '--');
  if (args[0] === 'time' && args[1] === 'query') {
    return { stdout: args[2] === 'gametime' ? 'The time is 9850000' : 'The time is 6420', exitCode: 0 };
  }
  if (args[0] === 'difficulty' && args.length === 1) return { stdout: 'The difficulty is Normal', exitCode: 0 };
  if (args[0] === 'gamerule' && args.length === 2) {
    const off = new Set([
      'keepInventory',
      'keep_inventory',
      'doInsomnia',
      'insomnia',
      'doImmediateRespawn',
      'immediate_respawn',
    ]);
    return { stdout: `Gamerule ${args[1]} is currently set to: ${off.has(args[1]) ? 'false' : 'true'}`, exitCode: 0 };
  }
  if (args[0] === 'weather') return { stdout: 'Changing to clear weather', exitCode: 0 };
  return { stdout: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Seeding

function sparse(abs, bytes) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fd = fs.openSync(abs, 'w');
  fs.ftruncateSync(fd, Math.round(bytes));
  fs.closeSync(fd);
}

function levelDat(nbt, s, seed) {
  const data = nbt.comp({
    LevelName: nbt.string('world'),
    Version: nbt.comp({ Name: nbt.string(s.mc), Id: nbt.int(4189) }),
    RandomSeed: nbt.long([0, seed]),
    DayTime: nbt.long([0, 6420]),
    Time: nbt.long([0, 9_850_000]),
    Difficulty: nbt.byte(2),
    SpawnX: nbt.int(128),
    SpawnY: nbt.int(72),
    SpawnZ: nbt.int(-64),
    raining: nbt.byte(0),
    thundering: nbt.byte(0),
    GameRules: nbt.comp({ keepInventory: nbt.string('false'), doDaylightCycle: nbt.string('true') }),
  });
  return zlib.gzipSync(nbt.writeUncompressed(nbt.comp({ Data: data }, '')));
}

async function seed() {
  const db = require('../../src/db');
  const { dataPath } = require('../../src/storage/pathGuard');
  const secrets = require('../../src/services/secrets');
  const auth = require('../../src/services/auth');
  const { recordEvent } = require('../../src/events');
  const nbt = require('prismarine-nbt');

  const admin = await auth.createUser({ ...ADMIN, role: 'admin' }, { actor: 'setup' });
  const maya = await auth.createUser(
    { username: 'maya', password: 'demo-password-123', role: 'operator' },
    { actor: ADMIN.username }
  );
  await auth.createUser(
    { username: 'jonas', password: 'demo-password-123', role: 'viewer' },
    { actor: ADMIN.username }
  );
  db.run("UPDATE users SET created_at = datetime('now', '-40 days') WHERE id = ?", admin.id);

  let port = 25565;
  for (const [i, s] of SERVERS.entries()) {
    db.run(
      `INSERT INTO servers (id, display_name, description, icon, accent, tags_json, type, mc_version, env_json,
         port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, cpus, disk_quota_bytes,
         update_policy, container_id, status, last_started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.name,
      s.description,
      s.icon,
      s.accent,
      JSON.stringify(s.tags),
      s.type,
      s.mc,
      JSON.stringify({ MOTD: s.motd, DIFFICULTY: 'normal', MAX_PLAYERS: '20', VIEW_DISTANCE: '12' }),
      port,
      port + 1000,
      secrets.encrypt('demo-rcon-password'),
      s.heap,
      s.mem,
      s.cpus,
      (i === 0 ? 20 : 10) * GB,
      i === 0 ? 'notify' : 'manual',
      `c0ffee${s.id.slice(4)}`,
      s.status,
      sqlTime(ago(isUp(s) ? 95 : 2000 + i * 300)),
      sqlTime(ago((30 - i * 3) * 24 * 60))
    );
    port += 1;

    const dir = dataPath('servers', s.id);
    fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), levelDat(nbt, s, 0x1f2e3d4c + i));
    sparse(path.join(dir, 'world', 'region', 'r.0.0.mca'), s.world * 0.7);
    sparse(path.join(dir, 'world', 'region', 'r.-1.0.mca'), s.world * 0.2);
    fs.mkdirSync(path.join(dir, 'world_nether', 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world_nether', 'level.dat'), levelDat(nbt, s, 1));
    sparse(path.join(dir, 'world_nether', 'region', 'r.0.0.mca'), s.world * 0.07);
    fs.mkdirSync(path.join(dir, 'world_the_end', 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world_the_end', 'level.dat'), levelDat(nbt, s, 2));
    sparse(path.join(dir, 'world_the_end', 'region', 'r.0.0.mca'), s.world * 0.03);
    fs.writeFileSync(
      path.join(dir, 'server.properties'),
      [
        `motd=${s.motd}`,
        'level-name=world',
        'max-players=20',
        'difficulty=normal',
        'pvp=true',
        'view-distance=12',
        'simulation-distance=10',
        'white-list=true',
        'spawn-protection=16',
        'enable-rcon=true',
        'rcon.password=',
        '',
      ].join('\n')
    );
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), consoleText(s.id));
    fs.writeFileSync(
      path.join(dir, 'logs', `${sqlTime(ago(1440)).slice(0, 10)}-1.log.gz`),
      zlib.gzipSync(consoleText(s.id))
    );
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'paper-global.yml'), 'chunk-system:\n  worker-threads: -1\n');
  }

  // Players: rosters, ops, bans, notes, and play sessions for the charts.
  const { seedPlayersForServer } = require('./fakePlayers');
  for (const id of ['srv_harbor', 'srv_fabric', 'srv_emerald']) await seedPlayersForServer(id, 10);
  const roster = ['Steve_Builds', 'MossyMiner', 'RedstoneRae', 'Kitsune42', 'PixelPiper', 'EnderEcho', 'BirchBard'];
  for (let d = 0; d < 14; d++) {
    for (const [i, name] of roster.entries()) {
      if ((d + i) % 3 === 0) continue;
      const start = ago(d * 1440 + 60 + i * 37);
      const end = new Date(start.getTime() + (40 + ((d * 7 + i * 13) % 140)) * 60000);
      db.run(
        'INSERT OR IGNORE INTO player_sessions (server_id, player, started_at, ended_at) VALUES (?, ?, ?, ?)',
        'srv_harbor',
        name,
        start.toISOString(),
        end.toISOString()
      );
      db.run(
        "INSERT INTO player_events (server_id, ts, type, player, message) VALUES ('srv_harbor', ?, 'join', ?, '')",
        start.toISOString(),
        name
      );
    }
  }
  const chat = [
    ['MossyMiner', 'anyone want to help with the harbor bridge?'],
    ['Steve_Builds', 'on my way, bringing spruce'],
    ['RedstoneRae', 'sorter is fixed, items go to the right chests now'],
    ['Kitsune42', 'the new farm is done :)'],
    ['PixelPiper', 'who left the nether portal unlit'],
  ];
  for (const [i, [player, message]] of chat.entries()) {
    db.run(
      "INSERT INTO player_events (server_id, ts, type, player, message) VALUES ('srv_harbor', ?, 'chat', ?, ?)",
      ago(60 - i * 8).toISOString(),
      player,
      message
    );
  }

  // History: a realistic spread of panel events over the last few days.
  const history = [
    ['srv_harbor', ADMIN.username, 'started', 'Server started.', 95],
    ['srv_harbor', 'scheduler', 'backup-created', 'Backup created (scheduled, 2.1 GB).', 300],
    ['srv_fabric', 'maya', 'content-installed', 'Mod installed: Sodium 0.6.13.', 140],
    ['srv_fabric', ADMIN.username, 'started', 'Server started.', 96],
    ['srv_nexus', 'system', 'crashed', 'Server crashed (exit code 1). A crash report was written.', 610],
    ['srv_nexus', 'watcher', 'auto-restarted', 'Auto-restart attempt 1/3 after a crash.', 605],
    ['srv_nexus', 'system', 'crashed', 'Server crashed (exit code 1). A crash report was written.', 600],
    ['srv_emerald', ADMIN.username, 'stopped', 'Server stopped.', 1500],
    ['srv_emerald', ADMIN.username, 'config-changed', 'Configuration changed: heapMb (rebuild required).', 1510],
    ['srv_molten', 'maya', 'world-reset', 'World reset with a random seed.', 2900],
    ['srv_harbor', ADMIN.username, 'player-whitelisted', 'Added BirchBard to the whitelist.', 3100],
    [null, ADMIN.username, 'user-created', 'User created: maya (operator).', 40 * 1440],
    ['srv_redstone', ADMIN.username, 'created', 'Server created.', 18 * 1440],
  ];
  // Seeding itself (whitelists, bans, notes) wrote events "now"; push them back
  // so the hand-written history below is what the pages lead with.
  db.run("UPDATE events SET created_at = datetime('now', '-9 days')");
  for (const [serverId, actor, type, summary, minutes] of history) {
    const id = recordEvent({ serverId, actor, type, summary });
    db.run('UPDATE events SET created_at = ? WHERE id = ?', sqlTime(ago(minutes)), id);
  }

  // Backups: real (sparse) archives so sizes and downloads look right.
  const backups = [
    ['srv_harbor', 'scheduled', '', 300, 2.1 * GB],
    ['srv_harbor', 'manual', 'Before the 1.21.4 update', 3 * 1440, 2.0 * GB],
    ['srv_harbor', 'pre-update', '', 3 * 1440 + 10, 2.0 * GB],
    ['srv_harbor', 'scheduled', '', 1440 + 300, 2.05 * GB],
    ['srv_fabric', 'manual', 'Clean test world', 2 * 1440, 0.8 * GB],
    ['srv_emerald', 'scheduled', '', 1500, 3.9 * GB],
    ['srv_nexus', 'pre-restore', '', 620, 1.6 * GB],
  ];
  for (const [i, [serverId, reason, note, minutes, size]] of backups.entries()) {
    const stamp = sqlTime(ago(minutes)).replace(/[: ]/g, '-');
    const filename = `${serverId.slice(4)}-${stamp}.zip`;
    const rel = `backups/${serverId}/${filename}`;
    sparse(dataPath(rel), size);
    db.run(
      `INSERT INTO backups (id, server_id, filename, rel_path, size_bytes, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `bk_demo${i}`,
      serverId,
      filename,
      rel,
      Math.round(size),
      reason,
      note,
      sqlTime(ago(minutes))
    );
  }

  // Schedules.
  const scheduler = require('../../src/services/scheduler');
  scheduler.createSchedule(
    { serverId: 'srv_harbor', taskType: 'backup', cron: '30 4 * * *' },
    { actor: ADMIN.username }
  );
  scheduler.createSchedule(
    { serverId: 'srv_harbor', taskType: 'restart', cron: '0 6 * * 1' },
    { actor: ADMIN.username }
  );
  scheduler.createSchedule({ serverId: 'srv_fabric', taskType: 'backup', cron: '15 3 * * *' }, { actor: 'maya' });
  scheduler.createSchedule(
    {
      serverId: 'srv_harbor',
      taskType: 'rcon',
      cron: '0 */2 * * *',
      payload: { command: 'say Remember to vote for the next build theme!' },
    },
    { actor: ADMIN.username }
  );

  // Mods on the Fabric server (overlay), with one update waiting.
  const mods = [
    ['Fabric API', 'fabric-api-0.116.1+1.21.1.jar', '0.116.1', 'P7dR8mSH', 2.2 * MB],
    ['Sodium', 'sodium-fabric-0.6.13+mc1.21.1.jar', '0.6.13', 'AANobbMI', 1.0 * MB],
    ['Lithium', 'lithium-fabric-0.15.0+mc1.21.1.jar', '0.15.0', 'gvQqBUqZ', 0.8 * MB],
    ['Iris Shaders', 'iris-fabric-1.8.8+mc1.21.1.jar', '1.8.8', 'YL57xq9U', 2.6 * MB],
    ['Mod Menu', 'modmenu-11.0.3.jar', '11.0.3', 'mOgUt4GM', 0.5 * MB],
    ["Xaero's Minimap", 'Xaeros_Minimap_25.2.0_Fabric_1.21.jar', '25.2.0', '1bokaNcj', 1.4 * MB],
    ['FerriteCore', 'ferritecore-7.0.2-fabric.jar', '7.0.2', 'uXXizFIs', 0.1 * MB],
  ];
  const crypto = require('node:crypto');
  for (const [i, [name, filename, version, projectId, size]] of mods.entries()) {
    const sha = crypto.createHash('sha256').update(filename).digest('hex');
    const rel = `library/mods/${sha.slice(0, 8)}-${filename}`;
    sparse(dataPath(rel), size);
    sparse(dataPath('servers', 'srv_fabric', 'mods', i === 4 ? `${filename}.disabled` : filename), size);
    db.run(
      `INSERT INTO library_files (id, category, name, filename, rel_path, sha256, size_bytes, platform, project_id, file_id, version)
       VALUES (?, 'mod', ?, ?, ?, ?, ?, 'modrinth', ?, ?, ?)`,
      `lib_mod${i}`,
      name,
      filename,
      rel,
      sha,
      Math.round(size),
      projectId,
      `f${i}`,
      version
    );
    db.run(
      `INSERT INTO server_content (id, server_id, library_id, kind, managed_by, name, filename, version, enabled)
       VALUES (?, 'srv_fabric', ?, 'mod', 'overlay', ?, ?, ?, ?)`,
      `sc_mod${i}`,
      `lib_mod${i}`,
      name,
      filename,
      version,
      i === 4 ? 0 : 1
    );
  }
  db.run(
    `INSERT INTO update_checks (subject_type, subject_id, current_version, latest_version, latest_name, changelog_url)
     VALUES ('content', 'sc_mod1', '0.6.13', '0.6.14', 'Sodium 0.6.14', 'https://modrinth.com/mod/sodium/changelog')`
  );
  db.run(
    `INSERT INTO update_checks (subject_type, subject_id, current_version, latest_version, latest_name)
     VALUES ('image', 'srv_harbor', '1.21.4', '1.21.5', 'Minecraft 1.21.5')`
  );

  // Crash reports on the hardcore modpack.
  for (const [i, minutes] of [610, 600].entries()) {
    const filename = `crash-${sqlTime(ago(minutes)).replace(/[: ]/g, '-')}-server.txt`;
    fs.mkdirSync(dataPath('servers', 'srv_nexus', 'crash-reports'), { recursive: true });
    fs.writeFileSync(
      dataPath('servers', 'srv_nexus', 'crash-reports', filename),
      '---- Minecraft Crash Report ----\nDescription: Ticking entity\n\njava.lang.NullPointerException: Cannot invoke "net.minecraft.world.entity.Entity.getId()"\n'
    );
    db.run(
      `INSERT INTO crash_reports (id, server_id, filename, file_mtime, size_bytes, summary, exception, suspected_json)
       VALUES (?, 'srv_nexus', ?, ?, 2048, 'Ticking entity', 'java.lang.NullPointerException: Cannot invoke "Entity.getId()"', ?)`,
      `cr_demo${i}`,
      filename,
      ago(minutes).toISOString(),
      JSON.stringify([{ modId: 'create', name: 'Create', confidence: 'high' }])
    );
  }

  // World library.
  for (const [i, [name, source, size]] of [
    ['Harbor SMP (season 2)', 'extract:srv_harbor', 1.9 * GB],
    ['Skyblock starter', 'upload', 12 * MB],
    ['Redstone test flat', 'extract:srv_redstone', 48 * MB],
  ].entries()) {
    const filename = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.zip`;
    const rel = `library/worlds/${filename}`;
    sparse(dataPath(rel), size);
    db.run(
      `INSERT INTO library_files (id, category, name, filename, rel_path, sha256, size_bytes, version, world_source, world_flavor)
       VALUES (?, 'world', ?, ?, ?, ?, ?, '1.21.4', ?, 'PAPER')`,
      `lib_world${i}`,
      name,
      filename,
      rel,
      require('node:crypto').createHash('sha256').update(name).digest('hex'),
      Math.round(size),
      source
    );
  }

  // Blueprints: the built-in starters plus one exported from Harbor.
  const blueprints = require('../../src/blueprints');
  await blueprints.seedStarters();
  await blueprints.exportBlueprint('srv_harbor', { includeConfig: true }, { actor: ADMIN.username });

  // Permissions: maya runs the Fabric server but cannot touch Harbor's files.
  const permissions = require('../../src/services/permissions');
  permissions.setGrant(maya.id, 'srv_harbor', ['view', 'console', 'power', 'players'], { actor: ADMIN.username });

  // Public API token, chat commands, Discord integration, status page.
  require('../../src/services/apiTokens').createToken({ label: 'Grafana', scopeAll: true }, { actor: ADMIN.username });
  db.run(
    `INSERT INTO chat_commands (id, server_id, "trigger", description, action, params, permission, cooldown_sec, uses)
     VALUES ('ccmd_rtp', 'srv_harbor', 'rtp', 'Teleport somewhere random', 'rtp', '{"radius":5000}', 'everyone', 300, 214),
            ('ccmd_village', 'srv_harbor', 'village', 'Find the nearest village', 'structure', '{"structure":"minecraft:village_plains"}', 'whitelist', 120, 57),
            ('ccmd_spawn', 'srv_harbor', 'spawn', 'Back to spawn', 'console', '{"command":"tp {player} 128 72 -64"}', 'everyone', 60, 391)`
  );
  try {
    require('../../src/integrations/statusPage').setStatusPage('srv_harbor', { enabled: true, slug: 'harbor-smp' });
  } catch {
    /* optional */
  }

  // Everything the seeding steps since the history above recorded (blueprint
  // export, permission grant, token, ...) is also old news.
  db.run("UPDATE events SET created_at = datetime('now', '-8 days') WHERE created_at > datetime('now', '-1 minute')");

  // A second admin with 2FA on, for the sign-in challenge screenshot.
  const sam = await auth.createUser(
    { username: 'sam', password: 'demo-password-123', role: 'admin' },
    { actor: ADMIN.username }
  );
  const totp = require('../../src/services/totp');
  const enrol = auth.beginTotpEnrollment(sam.id);
  await auth.confirmTotp(sam.id, enrol.secret, totp.codeAt(enrol.secret), 'demo-password-123', { actor: 'sam' });

  // Chatbot on Harbor, with a short transcript.
  db.run(
    `INSERT INTO wizard_configs (server_id, enabled, base_url, model, system_prompt, retention_days, invocation_name)
     VALUES ('srv_harbor', 1, 'http://127.0.0.1:11434', 'llama3.1:8b', '', 14, 'sage')`
  );
  const talk = [
    ['Kitsune42', 'user', 'how do I make a beacon?'],
    [
      'Kitsune42',
      'assistant',
      'You need a Nether Star, 3 Obsidian and 5 Glass in a crafting table, then a pyramid of iron, gold, emerald or diamond blocks under it.',
    ],
    ['MossyMiner', 'user', 'where is the nearest village?'],
    ['MossyMiner', 'assistant', 'Try !village, it points you to the nearest plains village.'],
  ];
  for (const [i, [player, role, content]] of talk.entries()) {
    db.run(
      'INSERT INTO wizard_transcripts (server_id, server_name, player, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'srv_harbor',
      'Harbor SMP',
      player,
      role,
      content,
      sqlTime(ago(120 - i * 2))
    );
  }

  // Discord notifications for Harbor.
  require('../../src/integrations/discord').setConfig('srv_harbor', {
    enabled: true,
    webhookUrl: 'https://discord.com/api/webhooks/1300000000000000000/demo-token-not-real',
    events: { start: true, stop: true, crash: true, backup: true, join: false },
  });

  // A finished version-compatibility scan for the Fabric server.
  const compat = require('../../src/services/compat');
  const items = await compat.inventory('srv_fabric');
  const later = ['1.21.2', '1.21.3', '1.21.4', '1.21.5'];
  const until = { P7dR8mSH: 4, AANobbMI: 4, gvQqBUqZ: 4, YL57xq9U: 3, '1bokaNcj': 4, uXXizFIs: 2 };
  const support = new Map(
    items
      .filter((it) => it.platform && it.projectId)
      .map((it) => [
        `${it.platform}:${it.projectId}`,
        {
          versions: Object.fromEntries(
            ['1.21.1', ...later.slice(0, until[it.projectId] ?? 4)].map((v) => [v, ['fabric']])
          ),
        },
      ])
  );
  const matrix = compat.buildMatrix(items, support, { loader: 'fabric', mcVersion: '1.21.1', candidates: later });
  db.run(
    `INSERT INTO version_compat (server_id, loader, mc_version, mods_signature, status, done, total, payload_json, started_at, updated_at, completed_at)
     VALUES ('srv_fabric', 'fabric', '1.21.1', ?, 'done', ?, ?, ?, ?, ?, ?)`,
    compat.modsSignature('srv_fabric'),
    matrix.knownCount,
    matrix.modCount,
    JSON.stringify(matrix),
    sqlTime(ago(30)),
    sqlTime(ago(29)),
    sqlTime(ago(29))
  );

  // The fake-player helper signs its work as 'seed-script'; attribute it to a person.
  db.run("UPDATE events SET actor = 'maya' WHERE actor = 'seed-script'");

  // Push notifications on two of alex's devices (the browser in the screenshots
  // is stubbed to own the first endpoint, see docsShots.js).
  const push = require('../../src/services/push');
  push.publicKey(); // creates the VAPID key pair
  for (const [i, [name, ua, prefs]] of [
    [
      'Pixel 8 · Chrome',
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/131 Mobile',
      {
        categories: { lifecycle: true, joins: true },
        quiet: { enabled: true, from: '23:00', to: '07:00', allowCritical: true },
      },
    ],
    ['iPad · Safari', 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) Safari/605', {}],
  ].entries()) {
    db.run(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth_cipher, device_name, user_agent, prefs_json, created_at, last_sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `push_demo${i}`,
      admin.id,
      i === 0 ? DEMO_ENDPOINT : 'https://web.push.apple.com/QDemoIpadEndpoint',
      'B'.repeat(87),
      secrets.encrypt('demoauthsecret00demo'),
      name,
      ua,
      JSON.stringify(push.normalizePrefs(prefs)),
      sqlTime(ago(9 * 1440 + i * 600)),
      sqlTime(ago(35 + i * 300))
    );
  }

  // History lists sort by id. Re-number every event in time order so the
  // backdated ones sit where their timestamps say.
  db.exec(`
    CREATE TEMP TABLE ev_sorted AS SELECT server_id, actor, type, summary, details_json, log_excerpt_path, created_at
      FROM events ORDER BY created_at, id;
    DELETE FROM events;
    INSERT INTO events (server_id, actor, type, summary, details_json, log_excerpt_path, created_at)
      SELECT server_id, actor, type, summary, details_json, log_excerpt_path, created_at FROM ev_sorted;
    DROP TABLE ev_sorted;
  `);

  // Storage index for the storage page and dashboard totals.
  await require('../../src/storage/indexer').scan();
}

/** A small Modrinth .mrpack (index only) for the import preview screenshot. */
async function mrpack() {
  const { ZipArchive } = require('archiver');
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const chunks = [];
  zip.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    zip.on('end', resolve);
    zip.on('error', reject);
  });
  const file = (name, project, version, size) => ({
    path: `mods/${name}`,
    hashes: { sha1: '0'.repeat(40), sha512: '0'.repeat(128) },
    env: { client: 'required', server: 'required' },
    downloads: [`https://cdn.modrinth.com/data/${project}/versions/${version}/${name}`],
    fileSize: size,
  });
  zip.append(
    JSON.stringify({
      formatVersion: 1,
      game: 'minecraft',
      versionId: '2.4.0',
      name: 'Cozy Adventures',
      summary: 'Light exploration pack with performance mods.',
      files: [
        file('fabric-api-0.116.1+1.21.1.jar', 'P7dR8mSH', 'v1', 2300000),
        file('sodium-fabric-0.6.13+mc1.21.1.jar', 'AANobbMI', 'v2', 1050000),
        file('lithium-fabric-0.15.0+mc1.21.1.jar', 'gvQqBUqZ', 'v3', 820000),
        file('terralith-2.5.8.jar', '8oi3bsk5', 'v4', 4100000),
        file('waystones-fabric-21.1.13.jar', 'LOpKHB2A', 'v5', 640000),
      ],
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
    }),
    { name: 'modrinth.index.json' }
  );
  zip.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function signIn(page, base) {
  await page.goto(`${base}/login`);
  await page.fill('input[name="username"]', ADMIN.username);
  await page.fill('input[name="password"]', ADMIN.password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type="submit"]')]);
}

module.exports = { SERVERS, ADMIN, DEMO_ENDPOINT, seed, signIn, inspect, live, liveAll, consoleText, exec, mrpack };

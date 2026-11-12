'use strict';

// The shipped compose files pin the panel image to the current release (F-13),
// so the default tag must move with package.json on every version bump.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');

for (const file of ['docker-compose.yml', 'deploy/docker-compose.socket-proxy.yml']) {
  test(`${file} pins the panel image to v${version}`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const m = /image: ghcr\.io\/doubleangels\/oxyx:\$\{OXYX_TAG:-(v[^}]+)\}/.exec(text);
    assert.ok(m, 'panel image uses ${OXYX_TAG:-vX.Y.Z}');
    assert.equal(m[1], `v${version}`, 'bump the default tag together with package.json');
  });
}

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

test('the runtime image is bare Alpine with the Node binary: no package manager, scripts or build inputs', () => {
  assert.match(runtime, /^\nFROM alpine:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} AS runtime/);
  assert.match(runtime, /COPY --from=build \/usr\/local\/bin\/node \/usr\/local\/bin\/node/);
  assert.match(runtime, /COPY --from=build \/prod\/node_modules \.\/node_modules/);
  assert.doesNotMatch(runtime, /pnpm|npm install|corepack/);
  assert.doesNotMatch(runtime, /COPY (scripts|assets|test|docs)\b/);
  assert.match(runtime, /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
});

test('both base images are pinned by digest and share one Alpine release', () => {
  const node = /^FROM node:(\d+)\.\d+\.\d+-alpine(\d+\.\d+)@sha256:[0-9a-f]{64} AS build$/m.exec(dockerfile);
  const alpine = /^FROM alpine:(\d+\.\d+)\.\d+@sha256:[0-9a-f]{64} AS runtime$/m.exec(dockerfile);
  assert.ok(node && alpine, 'FROM lines carry version and digest');
  assert.equal(node[1], '24', 'Node 24 LTS (package.json engines)');
  assert.equal(node[2], alpine[1], 'the node binary is copied onto the same Alpine release it was built for');
});

test('.dockerignore is an allowlist covering exactly what the Dockerfile copies', () => {
  const lines = fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.equal(lines[0], '*', 'everything is excluded first');
  const allowed = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1).replace(/\/$/, ''));
  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].split(/\s+/));
  for (const src of copied) assert.ok(allowed.includes(src), `${src} is copied but not allowed by .dockerignore`);
  for (const a of allowed) assert.ok(copied.includes(a), `${a} is allowed but never copied`);
  assert.ok(
    lines.includes('public/dist') && lines.includes('public/css/app.css'),
    'build outputs are rebuilt, never copied'
  );
});

test('CI publishes linux/amd64 only', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const platforms = [...ci.matchAll(/platforms: (\S+)/g)].map((m) => m[1]);
  assert.ok(platforms.length >= 2, 'PR build and publish both set a platform');
  assert.deepEqual([...new Set(platforms)], ['linux/amd64']);
  assert.doesNotMatch(ci, /arm64/);
});

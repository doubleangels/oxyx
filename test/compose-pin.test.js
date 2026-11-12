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

test('the runtime image carries no package manager', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.doesNotMatch(runtime, /pnpm (install|fetch)|npm install|lib\/node_modules\/pnpm/);
  assert.match(runtime, /COPY --from=build \/prod\/node_modules \.\/node_modules/);
});

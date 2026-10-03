'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { FILES, BASE, UpdateManager, validateManifest, validateBundle, newer, fingerprint } = require('../src/updater.cjs');
const root = path.join(__dirname, '..');
const current = require('../package.json').version;
const parts = current.split('.').map(Number); parts[2]++;
const next = parts.join('.');
function fixture() {
  const files = {};
  for (const name of FILES) {
    const encoding = name.endsWith('.png') ? 'base64' : 'utf8';
    let content = fs.readFileSync(path.join(root, name)).toString(encoding);
    if (name === 'package.json' || name === 'package-lock.json') {
      const value = JSON.parse(content); value.version = next;
      if (value.packages) value.packages[''].version = next;
      content = JSON.stringify(value);
    }
    files[name] = { encoding, content };
  }
  const bundle = { schema: 1, version: next, files };
  const bytes = Buffer.from(JSON.stringify(bundle));
  const manifest = { schema: 1, version: next, url: `${BASE}updates/${next}.json`, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { bundle, bytes, manifest };
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-updates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('stages verified source and activates it only after startup preparation succeeds', async t => {
  const f = fixture(); const dir = directory(t); let prepares = 0; let bundles = 0;
  const manager = new UpdateManager({ currentRoot: root, directory: dir,
    fetchFn: async url => { if (url.endsWith('update.json')) return Response.json(f.manifest); bundles++; return new Response(f.bytes); },
    prepare: async stage => { prepares++; assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'))).version, next); assert.equal(fs.existsSync(path.join(dir, 'active.json')), false); },
  });
  await manager.check();
  assert.equal(manager.state.status, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'active.json'))).version, next);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'active.json'))).previousVersion, current);
  await manager.check(); assert.equal(prepares, 1); assert.equal(bundles, 1);
});
test('a failed checksum cannot execute preparation or replace the active version', async t => {
  const f = fixture(); f.manifest.sha256 = '0'.repeat(64); const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'active.json'), '{"version":"previous"}');
  let prepares = 0;
  const manager = new UpdateManager({ currentRoot: root, directory: dir,
    fetchFn: async url => url.endsWith('update.json') ? Response.json(f.manifest) : new Response(f.bytes), prepare: async () => { prepares++; } });
  await manager.check();
  assert.equal(manager.state.status, 'error'); assert.equal(prepares, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'active.json'), 'utf8'), '{"version":"previous"}');
});
test('failed startup preparation cleans staging without deleting linked live dependencies', async t => {
  const f = fixture(); const dir = directory(t); const live = path.join(dir, 'live');
  fs.mkdirSync(live); fs.writeFileSync(path.join(live, 'keep.txt'), 'keep');
  const manager = new UpdateManager({ currentRoot: root, directory: dir,
    fetchFn: async url => url.endsWith('update.json') ? Response.json(f.manifest) : new Response(f.bytes),
    prepare: async stage => { fs.symlinkSync(live, path.join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); throw new Error('startup failed'); } });
  await manager.check(); assert.equal(manager.state.status, 'error');
  assert.equal(fs.existsSync(path.join(dir, 'active.json')), false);
  assert.equal(fs.readFileSync(path.join(live, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(!fs.readdirSync(path.join(dir, 'versions')).some(name => name.startsWith('.staging-')));
});
test('rejects path traversal, unexpected files and package identity mismatches', () => {
  const f = fixture(); f.bundle.files['../settings.json'] = { encoding: 'utf8', content: 'bad' };
  assert.throws(() => validateBundle(f.bundle, next));
  delete f.bundle.files['../settings.json'];
  const pkg = JSON.parse(f.bundle.files['package.json'].content); pkg.name = 'other-app';
  f.bundle.files['package.json'].content = JSON.stringify(pkg);
  assert.throws(() => validateBundle(f.bundle, next));
});
test('update origin is fixed and only stable increasing versions can be installed', () => {
  const f = fixture();
  assert.throws(() => validateManifest({ ...f.manifest, url: 'https://unrelated.example/app.json' }));
  assert.throws(() => validateManifest({ ...f.manifest, version: '../../folder' }));
  assert.equal(newer('0.10.0', '0.9.0'), true); assert.equal(newer('0.2.0', '0.2.0'), false);
  assert.equal(newer('0.1.0', '0.2.0'), false); assert.equal(newer('latest', '0.1.0'), false);
});

test('future versions may add source modules while credential and launcher paths remain protected', () => {
  const f = fixture(); f.bundle.files['src/new-feature.cjs'] = { encoding: 'utf8', content: 'module.exports = {};\n' };
  assert.ok(validateBundle(f.bundle, next).has('src/new-feature.cjs'));
  for (const name of ['src/../../settings.json', 'src\\escape.cjs', 'auth.json', 'src/.codex/auth.json']) {
    f.bundle.files[name] = { encoding: 'utf8', content: 'bad' };
    assert.throws(() => validateBundle(f.bundle, next)); delete f.bundle.files[name];
  }
});
test('root version changes may reuse dependencies, dependency changes cannot', () => {
  const old = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const nextLock = JSON.parse(JSON.stringify(old)); nextLock.version = next; nextLock.packages[''].version = next;
  assert.equal(fingerprint(old), fingerprint(nextLock));
  nextLock.packages['node_modules/electron'].integrity = 'different';
  assert.notEqual(fingerprint(old), fingerprint(nextLock));
});
test('coalesces simultaneous update checks and does not download older releases', async t => {
  let calls = 0; let finish;
  const manager = new UpdateManager({ currentRoot: root, directory: directory(t), fetchFn: async () => {
    calls++; return new Promise(resolve => { finish = () => resolve(Response.json({ ...fixture().manifest, version: current, url: `${BASE}updates/${current}.json` })); });
  }, prepare: async () => { throw new Error('must not prepare'); } });
  const one = manager.check(); const two = manager.check(); finish(); await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(manager.state.status, 'current');
});
test('unavailable or oversized manifests leave the installed app untouched', async t => {
  for (const response of [new Response('', { status: 404 }), new Response('x'.repeat(64001))]) {
    const manager = new UpdateManager({ currentRoot: root, directory: directory(t), fetchFn: async () => response, prepare: async () => { throw new Error('must not prepare'); } });
    await manager.check(); assert.equal(manager.state.status, 'error');
  }
});

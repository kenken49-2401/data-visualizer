'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatGPTAutostart, RUN_VALUE_NAME } = require('../src/autostart.cjs');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-autostart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user data 日本語'), resourcesPath = path.join(root, 'installed resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(path.join(resourcesPath, 'chatgpt-launch-watcher.exe'), 'synthetic GUI helper version one');
  const executable = path.join(root, 'installed app 日本語', 'Codex Usage Overlay.exe');
  const registry = new Map(), calls = [], starts = [], stops = [], queries = [];
  const app = {
    isPackaged: true, getPath: () => userData,
    getLoginItemSettings(options) {
      queries.push(options);
      assert(options.path.startsWith('"') && options.path.endsWith('"'), 'Lookup preserves executable paths containing spaces');
      const executablePath = options.path.slice(1, -1);
      const items = [...registry.values()].filter(item => item.path === executablePath).map(item => ({ ...item }));
      // Electron reads openAtLogin using AppUserModelID, not our custom Run name.
      return { openAtLogin: false, executableWillLaunchAtLogin: items.some(item => item.enabled), launchItems: items };
    },
    setLoginItemSettings(options) {
      calls.push(options);
      assert.equal(options.name, RUN_VALUE_NAME, 'Only our own Run/StartupApproved value may change');
      if (!options.openAtLogin) registry.delete(options.name);
      else registry.set(options.name, { name: options.name, scope: 'user', path: options.path, args: options.args, enabled: options.enabled });
    }
  };
  const manager = new ChatGPTAutostart({ app, platform: 'win32', resourcesPath, executable, userData,
    runStop: async file => { stops.push(file); }, runStart: async (file, args) => { starts.push({ file, args }); }, ...overrides });
  return { manager, app, root, userData, resourcesPath, executable, registry, calls, starts, stops, queries,
    config: () => JSON.parse(fs.readFileSync(manager.file, 'utf8')) };
}

test('non-Windows, source runs and disabled demo/smoke runs never change autostart', async t => {
  for (const overrides of [{ platform: 'linux' }, { disabled: true }]) {
    const f = fixture(t, overrides);
    assert.deepEqual(await f.manager.reconcile(true), { supported: false, status: 'disabled', enabled: false });
    await f.manager.reconcile(false, { explicit: true });
    assert.equal(fs.existsSync(f.manager.directory), false);
    assert.equal(f.calls.length + f.queries.length + f.starts.length + f.stops.length, 0);
  }
  const f = fixture(t); f.app.isPackaged = false;
  const manager = new ChatGPTAutostart({ app: f.app, platform: 'win32', userData: f.userData });
  await manager.reconcile(true); assert.equal(f.calls.length, 0); assert.equal(manager.state.supported, false);
});

test('first setup stages a versioned GUI helper and registers raw Unicode/space paths without a shell', async t => {
  const f = fixture(t), result = await f.manager.reconcile(true);
  assert.deepEqual(result, { supported: true, status: 'enabled', enabled: true });
  const config = f.config(), call = f.calls[0], start = f.starts[0];
  assert.equal(config.schema, 1); assert.equal(config.enabled, true); assert.equal(config.appPath, f.executable);
  assert.equal(config.registered, true); assert.match(config.helperFile, /^watcher-[a-f0-9]{16}\.exe$/);
  assert.equal(call.path, path.join(f.manager.directory, config.helperFile));
  assert.equal(call.openAtLogin, true); assert.equal(call.enabled, true);
  assert.deepEqual(call.args, ['--config', f.manager.file]);
  assert.deepEqual(start, { file: call.path, args: ['--config', f.manager.file] });
  assert.equal(f.stops[0], call.path);
  assert.equal(fs.readFileSync(call.path, 'utf8'), 'synthetic GUI helper version one');
  assert(!call.path.startsWith(f.resourcesPath), 'The running helper must not lock installer resources');
  await f.manager.reconcile(true);
  assert.equal(f.calls.length, 1, 'Ordinary startup does not rewrite startup approval');
});

test('explicit disable persists opt-out before stopping, removes only its Run entry and retains history', async t => {
  const f = fixture(t); await f.manager.reconcile(true);
  const history = path.join(f.userData, 'history.json'); fs.writeFileSync(history, 'keep this history');
  f.registry.set('UnrelatedApp', { name: 'UnrelatedApp', scope: 'user', path: 'other.exe', enabled: true });
  f.manager.runStop = async () => assert.equal(f.config().enabled, false, 'Stop may fail, but saved configuration already disables the watcher');
  assert.deepEqual(await f.manager.reconcile(false, { explicit: true }), { supported: true, status: 'disabled', enabled: false });
  assert.equal(f.registry.has(RUN_VALUE_NAME), false); assert.equal(f.registry.has('UnrelatedApp'), true);
  assert.equal(f.config().enabled, false); assert.equal(fs.readFileSync(history, 'utf8'), 'keep this history');
  assert.deepEqual(f.calls.at(-1), { name: RUN_VALUE_NAME, openAtLogin: false });
});

test('Task Manager opt-out remains disabled during startup and helper updates until explicit enable', async t => {
  const f = fixture(t); await f.manager.reconcile(true);
  const oldFile = f.calls[0].path, originalStarts = f.starts.length;
  f.registry.get(RUN_VALUE_NAME).enabled = false;
  const writes = f.calls.length;
  assert.equal((await f.manager.reconcile(true)).status, 'os-disabled');
  assert.equal(f.calls.length, writes); assert.equal(f.starts.length, originalStarts);
  fs.writeFileSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'), 'synthetic helper version two');
  assert.equal((await f.manager.reconcile(true)).status, 'os-disabled');
  const migrated = f.registry.get(RUN_VALUE_NAME);
  assert.notEqual(migrated.path, oldFile); assert.equal(migrated.enabled, false);
  assert.equal(f.starts.length, originalStarts); assert.equal(fs.existsSync(oldFile), false);
  assert.equal(f.config().enabled, true, 'Future explicit OS re-enabling can still run the saved configuration');
  assert.equal((await f.manager.reconcile(true, { explicit: true })).status, 'enabled');
  assert.equal(f.registry.get(RUN_VALUE_NAME).enabled, true); assert.equal(f.starts.length, originalStarts + 1);
});

test('removing the startup entry is respected across app launches and helper migration', async t => {
  const f = fixture(t); await f.manager.reconcile(true); f.registry.delete(RUN_VALUE_NAME);
  const writes = f.calls.length, starts = f.starts.length;
  assert.equal((await f.manager.reconcile(true)).status, 'os-disabled');
  fs.writeFileSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'), 'new synthetic helper');
  assert.equal((await f.manager.reconcile(true)).status, 'os-disabled');
  assert.equal(f.calls.length, writes); assert.equal(f.starts.length, starts); assert.equal(f.registry.size, 0);
  await f.manager.reconcile(true, { explicit: true });
  assert.equal(f.registry.get(RUN_VALUE_NAME).enabled, true);
});

test('enabled registration migrates to a new content-addressed helper and ignores unrelated files', async t => {
  const f = fixture(t); await f.manager.reconcile(true); const original = f.calls[0].path;
  const unrelated = path.join(f.manager.directory, 'backup-personal.exe'); fs.writeFileSync(unrelated, 'unrelated');
  fs.writeFileSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'), 'replacement helper');
  await f.manager.reconcile(true);
  assert.equal(f.manager.state.status, 'enabled'); assert.notEqual(f.calls.at(-1).path, original);
  assert.equal(fs.existsSync(original), false); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated');
  assert.equal(f.stops.at(-1), f.calls.at(-1).path);
});

test('corrupt or traversal metadata cannot launch arbitrary executables and explicit opt-out repairs it', async t => {
  const f = fixture(t); fs.mkdirSync(f.manager.directory, { recursive: true });
  fs.writeFileSync(f.manager.file, JSON.stringify({ schema: 1, enabled: true, helperFile: '../../unrelated.exe' }));
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(f.calls.length + f.starts.length + f.stops.length, 0);
  assert.equal((await f.manager.reconcile(false, { explicit: true })).status, 'disabled');
  assert.equal(f.config().enabled, false);
  await f.manager.reconcile(true, { explicit: true }); assert.equal(f.manager.state.status, 'enabled');
});

test('registration and process failures are contained and a later explicit attempt can recover', async t => {
  const f = fixture(t);
  f.manager.runStart = async () => { throw new Error('private path must not escape'); };
  assert.deepEqual(await f.manager.reconcile(true), { supported: true, status: 'error', enabled: false });
  assert.equal(JSON.stringify(f.manager.state).includes('private'), false);
  f.manager.runStart = async () => {};
  assert.equal((await f.manager.reconcile(true, { explicit: true })).status, 'enabled');
  f.manager.runStop = async () => { throw new Error('process shutdown failed'); };
  assert.equal((await f.manager.reconcile(false, { explicit: true })).status, 'error');
  assert.equal(f.config().enabled, false); assert.equal(f.registry.has(RUN_VALUE_NAME), false);
});

test('rapid preference changes are serialized and the last requested preference wins', async t => {
  const f = fixture(t); let release, entered;
  const starting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let stops = 0;
  f.manager.runStop = async () => { if (++stops === 1) { entered(); await gate; } };
  const enable = f.manager.reconcile(true);
  await starting;
  const disable = f.manager.reconcile(false, { explicit: true });
  const reenable = f.manager.reconcile(true, { explicit: true });
  release();
  const results = await Promise.all([enable, disable, reenable]);
  assert.deepEqual(results.map(result => result.status), ['enabled', 'disabled', 'enabled']);
  assert.equal(f.manager.state.status, 'enabled'); assert.equal(f.config().enabled, true);
  assert.equal(f.registry.get(RUN_VALUE_NAME).enabled, true);
});

test('missing resources and damaged staged helpers fail before being executed', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'));
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(f.starts.length + f.stops.length + f.calls.length, 0);
  assert.equal((await f.manager.reconcile(false, { explicit: true })).status, 'disabled');
  fs.writeFileSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'), 'synthetic GUI helper version one');
  await f.manager.reconcile(true, { explicit: true });
  fs.writeFileSync(f.calls.at(-1).path, 'damaged helper');
  const starts = f.starts.length, stops = f.stops.length;
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(f.starts.length, starts); assert.equal(f.stops.length, stops);
});

test('temporary Windows rename locks retry atomically without leaving partial configuration', async t => {
  const f = fixture(t), rename = fs.promises.rename.bind(fs.promises); let busy = 0;
  t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (destination === f.manager.file && busy++ < 2) throw Object.assign(new Error('temporarily locked'), { code: 'EBUSY' });
    return rename(source, destination);
  });
  assert.equal((await f.manager.reconcile(true)).status, 'enabled');
  assert.equal(f.config().enabled, true); assert(busy >= 3);
  assert.equal(fs.readdirSync(f.manager.directory).some(name => name.endsWith('.tmp')), false);
});

test('persistent rename locks preserve the old configuration and fail without a registry mutation', async t => {
  const f = fixture(t); fs.mkdirSync(f.manager.directory, { recursive: true });
  const previous = JSON.stringify({ schema: 1, enabled: false, registered: false });
  fs.writeFileSync(f.manager.file, previous); let attempts = 0;
  t.mock.method(fs.promises, 'rename', async () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(attempts, 5); assert.equal(fs.readFileSync(f.manager.file, 'utf8'), previous);
  assert.equal(f.calls.length + f.starts.length, 0);
  assert.equal(fs.readdirSync(f.manager.directory).some(name => name.endsWith('.tmp')), false);
});

test('failed first registration or helper migration remains retryable without resetting an existing opt-out', async t => {
  const f = fixture(t), setter = f.app.setLoginItemSettings;
  f.app.setLoginItemSettings = () => { throw new Error('registry temporarily unavailable'); };
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(f.config().registered, false);
  f.app.setLoginItemSettings = setter;
  assert.equal((await f.manager.reconcile(true)).status, 'enabled');
  const old = f.config().helperFile;
  fs.writeFileSync(path.join(f.resourcesPath, 'chatgpt-launch-watcher.exe'), 'new helper whose first registration fails');
  f.app.setLoginItemSettings = () => { throw new Error('registry temporarily unavailable'); };
  assert.equal((await f.manager.reconcile(true)).status, 'error');
  assert.equal(f.config().helperFile, old); assert.equal(fs.existsSync(path.join(f.manager.directory, old)), true);
  f.app.setLoginItemSettings = setter;
  assert.equal((await f.manager.reconcile(true)).status, 'enabled');
  assert.notEqual(f.config().helperFile, old); assert.equal(f.registry.get(RUN_VALUE_NAME).enabled, true);
});

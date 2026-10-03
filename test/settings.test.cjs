'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, normalizeSettings } = require('../src/settings.cjs');
const { keepOnScreen } = require('../src/position.cjs');
test('persists position, size and polling interval across a restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir);
  store.update({ mode: 'manual', x: -1000, y: 350, size: 'tiny', intervalSeconds: 180, autoUpdates: false });
  assert.deepEqual(new SettingsStore(dir).value, store.value);
});
test('preserves corrupt settings and recovers without losing the original file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'settings.json'), 'corrupt user configuration');
  const store = new SettingsStore(dir);
  store.update({ size: 'tiny' });
  const backup = fs.readdirSync(dir).find(name => name.startsWith('settings.json.backup-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), 'corrupt user configuration');
  assert.equal(new SettingsStore(dir).value.size, 'tiny');
});
test('invalid settings cannot create a tiny polling interval or unusable positions', () => {
  const settings = normalizeSettings({ mode: 'unknown', x: Infinity, y: '1', intervalSeconds: 1, size: '../../file', autoUpdates: 'true' });
  assert.equal(settings.intervalSeconds, 60); assert.equal(settings.mode, 'screen'); assert.equal(settings.x, null);
  assert.equal(settings.size, 'compact'); assert.equal(settings.autoUpdates, true);
});
test('moving or disconnecting a monitor keeps the complete panel reachable', () => {
  const area = { x: -1920, y: -1080, width: 1920, height: 1080 };
  const result = keepOnScreen({ x: 9999, y: -9999, width: 292, height: 204 }, area);
  assert.equal(result.x, -292); assert.equal(result.y, -1080);
  const small = keepOnScreen({ x: -10, y: -10, width: 292, height: 204 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(small, { x: 0, y: 0, width: 100, height: 100 });
});

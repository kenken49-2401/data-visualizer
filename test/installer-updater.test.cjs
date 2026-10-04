'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InstallerUpdater } = require('../src/installer-updater.cjs');
test('installer update is downloaded without interrupting work and installed on demand', async () => {
  const backend = new EventEmitter(); let checks = 0, installs = 0;
  backend.checkForUpdates = async () => { checks++; backend.emit('checking-for-update'); backend.emit('update-available', { version: '0.4.0' }); };
  backend.quitAndInstall = (silent, relaunch) => { assert.equal(silent, false); assert.equal(relaunch, true); installs++; };
  const updater = new InstallerUpdater(backend, '0.3.0');
  updater.install(); assert.equal(installs, 0);
  await updater.check(); assert.equal(updater.state.status, 'downloading');
  await updater.check(); assert.equal(checks, 1);
  backend.emit('update-downloaded', { version: '0.4.0' });
  await updater.check(); assert.equal(updater.state.status, 'ready'); assert.equal(installs, 0);
  updater.install(); assert.equal(installs, 1); assert.equal(backend.autoInstallOnAppQuit, true);
});
test('failed update leaves current version running and allows a retry', async () => {
  const backend = new EventEmitter(); let checks = 0;
  backend.checkForUpdates = async () => { checks++; throw new Error('offline'); };
  const updater = new InstallerUpdater(backend, '0.3.0');
  await updater.check(); await updater.check();
  assert.equal(checks, 2); assert.equal(updater.state.status, 'error'); assert.equal(updater.state.version, '0.3.0');
});

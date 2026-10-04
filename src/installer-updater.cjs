'use strict';
const { EventEmitter } = require('node:events');
class InstallerUpdater extends EventEmitter {
  constructor(updater, version) {
    super(); this.updater = updater; this.version = version; this.timer = null; this.checking = false;
    this.state = { status: 'idle', version, available: null };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = null;
    updater.on('checking-for-update', () => this.set('checking'));
    updater.on('update-available', info => this.set('downloading', info.version));
    updater.on('update-not-available', () => this.set('current'));
    updater.on('update-downloaded', info => this.set('ready', info.version));
    updater.on('error', () => this.set('error'));
  }
  set(status, available = this.state.available) { this.state = { status, version: this.version, available }; this.emit('state', this.state); }
  start() {
    if (this.timer) return;
    void this.check(); this.timer = setInterval(() => void this.check(), 30 * 60 * 1000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async check() {
    if (this.checking || ['downloading', 'ready'].includes(this.state.status)) return;
    this.checking = true;
    try { await this.updater.checkForUpdates(); } catch { this.set('error'); }
    finally { this.checking = false; }
  }
  install() { if (this.state.status === 'ready') this.updater.quitAndInstall(false, true); }
}
module.exports = { InstallerUpdater };

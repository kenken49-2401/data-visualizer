'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const RUN_VALUE_NAME = 'CodexUsageOverlayChatGPTLauncher';
const HELPER_FILE = /^watcher-[a-f0-9]{16}\.exe$/;
async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 4 || !['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25));
    }
  }
}
function stopWatcher(executable) {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--stop'], { windowsHide: true, timeout: 7000 }, error => error ? reject(error) : resolve());
  });
}
function startWatcher(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
class ChatGPTAutostart {
  constructor({ app, platform = process.platform, resourcesPath = process.resourcesPath,
    executable = process.execPath, userData = app.getPath('userData'), disabled = false,
    runStop = stopWatcher, runStart = startWatcher }) {
    this.app = app; this.executable = executable; this.resourcesPath = resourcesPath;
    this.directory = path.join(userData, 'autostart');
    this.file = path.join(this.directory, 'config.json');
    this.runStop = runStop; this.runStart = runStart; this.queue = Promise.resolve();
    const supported = platform === 'win32' && app.isPackaged === true && !disabled;
    this.state = { supported, status: supported ? 'idle' : 'disabled', enabled: false };
  }
  reconcile(enabled, { explicit = false } = {}) {
    const operation = this.queue.then(() => this.apply(enabled === true, explicit === true));
    this.queue = operation.catch(() => {});
    return operation;
  }
  setState(status, enabled = false) {
    this.state = { supported: this.state.supported, status, enabled };
    return this.state;
  }
  readConfig(explicit) {
    try {
      const config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (config?.schema !== 1 || typeof config.enabled !== 'boolean' ||
          config.helperFile != null && !HELPER_FILE.test(config.helperFile)) throw new Error('Invalid autostart configuration');
      return config;
    } catch (error) {
      if (error.code === 'ENOENT' || explicit) return null;
      throw error;
    }
  }
  async writeConfig(config) {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
      await replaceFile(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  stageHelper() {
    const bytes = fs.readFileSync(path.join(this.resourcesPath, 'chatgpt-launch-watcher.exe'));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const name = `watcher-${digest.slice(0, 16)}.exe`, destination = path.join(this.directory, name);
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') === digest) return { name, destination };
      // Never execute or replace a damaged existing helper; a repaired copy gets
      // installed on the next normal attempt once the bad file is removed.
      throw new Error('Damaged autostart helper');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o700 });
      fs.renameSync(temporary, destination);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
    return { name, destination };
  }
  registration(helper) {
    // Electron parses this lookup as a command line. Quoting the executable
    // preserves spaces; setLoginItemSettings itself quotes raw path/args.
    const settings = this.app.getLoginItemSettings({ path: `"${helper}"`, args: ['--config', this.file] });
    return settings.launchItems?.find(item => item.name === RUN_VALUE_NAME && item.scope === 'user') ?? null;
  }
  register(helper, enabled) {
    this.app.setLoginItemSettings({ name: RUN_VALUE_NAME, path: helper, args: ['--config', this.file], openAtLogin: true, enabled });
  }
  cleanup(current) {
    for (const name of fs.readdirSync(this.directory)) {
      if (name === current || !HELPER_FILE.test(name)) continue;
      try { fs.unlinkSync(path.join(this.directory, name)); } catch { /* A prior process may still be releasing its file. */ }
    }
  }
  async apply(enabled, explicit) {
    if (!this.state.supported) return this.state;
    try {
      const previous = this.readConfig(explicit);
      if (!enabled) {
        // Persist opt-out before attempting process shutdown, so even a helper
        // whose stop signal fails will exit on its next configuration check.
        await this.writeConfig({ schema: 1, enabled: false, appPath: this.executable, registered: true,
          ...(previous?.helperFile ? { helperFile: previous.helperFile } : {}) });
        this.app.setLoginItemSettings({ name: RUN_VALUE_NAME, openAtLogin: false });
        if (previous?.helperFile) {
          const helper = path.join(this.directory, previous.helperFile);
          if (fs.existsSync(helper) && createHash('sha256').update(fs.readFileSync(helper)).digest('hex').startsWith(previous.helperFile.slice(8, 24))) await this.runStop(helper);
        }
        return this.setState('disabled');
      }
      const helper = this.stageHelper();
      const priorPath = previous?.helperFile ? path.join(this.directory, previous.helperFile) : helper.destination;
      const prior = this.registration(priorPath);
      const registeredBefore = previous?.registered === true;
      const allowed = explicit || (!registeredBefore && !prior) || prior?.enabled === true;
      await this.runStop(helper.destination);
      // Keep the prior registration pointer until a migration is confirmed.
      // A failed registry write must remain retryable and must not look like a
      // user deleting the previously successful startup entry.
      const config = { schema: 1, enabled: true, appPath: this.executable,
        helperFile: previous?.helperFile ?? helper.name, registered: registeredBefore || !!prior };
      await this.writeConfig(config);
      if (!allowed) {
        // Preserve Task Manager's disabled state when migrating to a new helper.
        // A removed Run entry is also an opt-out; do not silently recreate it.
        if (prior && priorPath !== helper.destination) {
          this.register(helper.destination, false);
          if (!this.registration(helper.destination)) throw new Error('Autostart migration did not succeed');
        }
        await this.writeConfig({ ...config, helperFile: helper.name });
        this.cleanup(helper.name);
        return this.setState('os-disabled');
      }
      if (explicit || !prior || priorPath !== helper.destination) this.register(helper.destination, true);
      const active = this.registration(helper.destination);
      if (!active) throw new Error('Autostart registration did not succeed');
      await this.writeConfig({ ...config, helperFile: helper.name, registered: true });
      if (!active.enabled) return this.setState('os-disabled');
      await this.runStart(helper.destination, ['--config', this.file]);
      this.cleanup(helper.name);
      return this.setState('enabled', true);
    } catch { return this.setState('error'); }
  }
}
module.exports = { ChatGPTAutostart, RUN_VALUE_NAME };

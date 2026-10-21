'use strict';
// Windows CI only: exercise Electron's actual HKCU Run/StartupApproved APIs,
// the JavaScript manager, and the native GUI watcher together. No account or
// Codex services are opened and the fixture never runs the application main.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ChatGPTAutostart, RUN_VALUE_NAME } = require('../src/autostart.cjs');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.argv.includes('--synthetic-autostart')) {
  console.error('This native registry fixture runs only on Windows GitHub Actions with --synthetic-autostart');
  process.exit(1);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Codex 自動起動 fixture '));
app.setPath('userData', directory);
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
let manager, helper, timer, finishing = false;

function registryValue(key) {
  try { return execFileSync('reg.exe', ['query', key, '/v', RUN_VALUE_NAME], { windowsHide: true, stdio: 'pipe', timeout: 5000 }); }
  catch (error) { if (error.status === 1) return null; throw new Error('Could not inspect the fixture registry value'); }
}
function powershellNumber(source) {
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const output = execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  const text = output.toString('utf8').trim();
  if (!/^\d+$/.test(text)) throw new Error('Could not inspect the native fixture process');
  return Number(text);
}
function watcherCount() {
  const name = path.basename(helper, '.exe').replace(/'/g, "''"), exact = helper.replace(/'/g, "''");
  return powershellNumber(`@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exact}' }).Count`);
}
async function waitFor(check, message) {
  const until = Date.now() + 12000;
  do { if (check()) return; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < until);
  throw new Error(message);
}
function registration() {
  // Electron 44 parses this lookup as a Windows command line. Quote only the
  // executable lookup; getLoginItemSettings decodes actual arguments for us.
  const settings = app.getLoginItemSettings({ path: `"${helper}"`, args: ['--config', manager.file] });
  const item = settings.launchItems?.find(value => value.name === RUN_VALUE_NAME && value.scope === 'user');
  assert(item, 'The custom current-user Run entry must be visible to real Electron');
  assert.equal(path.resolve(item.path).toLowerCase(), path.resolve(helper).toLowerCase(), 'Run executable must be the staged helper');
  assert.deepEqual(item.args, ['--config', manager.file], 'Spaces and Japanese characters must survive native command-line quoting');
  return item;
}
async function main() {
  await app.whenReady();
  // Never overwrite an existing installation, even if someone misuses the CI
  // fixture on a persistent Windows runner.
  assert.equal(registryValue(RUN), null, 'An existing application Run entry is present; refusing to change it');
  assert.equal(registryValue(APPROVED), null, 'An existing StartupApproved entry is present; refusing to change it');
  const chatgptCount = powershellNumber('@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId }).Count');
  assert.equal(chatgptCount, 0, 'The isolated fixture must not run beside a real ChatGPT process');
  const adapter = {
    isPackaged: true,
    getPath: app.getPath.bind(app),
    setLoginItemSettings: app.setLoginItemSettings.bind(app),
    getLoginItemSettings: app.getLoginItemSettings.bind(app)
  };
  manager = new ChatGPTAutostart({ app: adapter, userData: directory,
    resourcesPath: path.join(__dirname, '..', 'build'), executable: process.execPath });
  const enabled = await manager.reconcile(true, { explicit: true });
  assert.equal(enabled.status, 'enabled', 'Real Electron registration must enable auto-start');
  assert.equal(enabled.enabled, true);
  const config = JSON.parse(fs.readFileSync(manager.file, 'utf8'));
  helper = path.join(directory, 'autostart', config.helperFile);
  assert(fs.existsSync(helper));
  assert.equal(config.appPath, process.execPath);
  assert.notEqual(path.resolve(helper), path.resolve(__dirname, '..', 'build', 'chatgpt-launch-watcher.exe'), 'The Run entry must use the staged user-data helper');
  assert.equal(registration().enabled, true);
  assert(registryValue(RUN), 'Electron must create the actual HKCU Run value');
  await waitFor(() => watcherCount() === 1, 'The manager did not start its native helper');

  // Simulate Task Manager's Startup tab using the exact native Electron API.
  app.setLoginItemSettings({ name: RUN_VALUE_NAME, path: helper, args: ['--config', manager.file], openAtLogin: true, enabled: false });
  assert.equal(registration().enabled, false, 'StartupApproved must report Task Manager opt-out');
  const disabledCommand = registryValue(RUN);
  assert(disabledCommand, 'Disabling startup keeps the existing Run command');
  const ordinary = await manager.reconcile(true);
  assert.equal(ordinary.status, 'os-disabled', 'Ordinary startup must preserve the Windows opt-out');
  assert.equal(ordinary.enabled, false);
  assert.equal(registration().enabled, false);
  assert(registryValue(RUN).equals(disabledCommand), 'Ordinary reconciliation must not rewrite the opted-out Run command');
  await waitFor(() => watcherCount() === 0, 'The opted-out helper must stay stopped');

  const explicit = await manager.reconcile(true, { explicit: true });
  assert.equal(explicit.status, 'enabled', 'An explicit user action must re-enable StartupApproved');
  assert.equal(registration().enabled, true);
  await waitFor(() => watcherCount() === 1, 'Explicit re-enable did not restart the native helper');

  const disabled = await manager.reconcile(false, { explicit: true });
  assert.equal(disabled.status, 'disabled');
  assert.equal(registryValue(RUN), null, 'Turning off auto-start must remove its own Run entry');
  assert.equal(registryValue(APPROVED), null, 'Turning off auto-start must remove its own StartupApproved entry');
  await waitFor(() => watcherCount() === 0, 'Turning off auto-start must stop the helper');
  assert.equal(JSON.parse(fs.readFileSync(manager.file, 'utf8')).enabled, false);
  console.log('Real Electron auto-start integration passed: HKCU registration, Unicode quoting, native helper, StartupApproved opt-out, explicit re-enable and cleanup');
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  let failed = Boolean(error);
  if (error) {
    const detail = String(error.stack || error.message).slice(-5500);
    console.error(detail);
    console.error('::error title=Real Electron auto-start::' + detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  }
  if (manager) {
    try {
      const state = await manager.reconcile(false, { explicit: true });
      if (state.status !== 'disabled' || registryValue(RUN) !== null || registryValue(APPROVED) !== null) throw new Error('Auto-start fixture cleanup failed');
    } catch (cleanupError) {
      const detail = String(cleanupError.message).slice(-1000);
      console.error('::error title=Auto-start fixture cleanup::' + detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
      failed = true;
    }
  }
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { }
  app.exit(failed ? 1 : 0);
}
timer = setTimeout(() => { void finish(new Error('Real Electron auto-start integration timed out')); }, 65000);
void main().then(() => finish()).catch(finish);

'use strict';
// Windows CI only: exercise Electron's actual HKCU Run/StartupApproved APIs,
// the JavaScript manager, and the native GUI watcher together. No account or
// Codex services are opened and the fixture never runs the application main.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { ChatGPTAutostart, RUN_VALUE_NAME } = require('../src/autostart.cjs');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.argv.includes('--synthetic-autostart')) {
  console.error('This native registry fixture runs only on Windows GitHub Actions with --synthetic-autostart');
  process.exit(1);
}
// The parent runner owns removal after Chromium has fully closed its profile.
// Removing userData while Electron/Crashpad still uses it can crash shutdown.
const directory = process.env.WEB_AUTOSTART_SMOKE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'Codex 自動起動 fixture '));
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.disableHardwareAcceleration();
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
let manager, helper, timer, finishing = false, cleanupVerified = false;

function registryValue(key) {
  try { return execFileSync('reg.exe', ['query', key, '/v', RUN_VALUE_NAME], { windowsHide: true, stdio: 'pipe', timeout: 5000 }); }
  catch (error) { if (error.status === 1) return null; throw new Error('Could not inspect the fixture registry value'); }
}
function powershellOutput(source) {
  const encoded = Buffer.from("$ErrorActionPreference = 'Stop'\n" + source, 'utf16le').toString('base64');
  const output = execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  return output.toString('utf8').trim();
}
function powershellNumber(source) {
  const text = powershellOutput(source);
  if (!/^\d+$/.test(text)) throw new Error('Could not inspect the native fixture process');
  return Number(text);
}
function registeredCommand() {
  // Read only this fixture's Run value, retain its Unicode string, and ask the
  // Windows command-line parser for *all* arguments, including --switches.
  const script = `
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try { $command = [string]$key.GetValue('${RUN_VALUE_NAME}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
finally { $key.Dispose() }
if ([string]::IsNullOrEmpty($command)) { throw 'The fixture Run command is missing' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureCommandLine {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@
$count = 0
$pointer = [FixtureCommandLine]::CommandLineToArgvW($command, [ref]$count)
if ($pointer -eq [IntPtr]::Zero) { throw 'Windows could not parse the fixture Run command' }
$arguments = [Collections.Generic.List[string]]::new()
try {
  for ($index = 0; $index -lt $count; $index++) {
    $item = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $index * [IntPtr]::Size)
    $arguments.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($item))
  }
} finally { [void][FixtureCommandLine]::LocalFree($pointer) }
$json = ConvertTo-Json -InputObject @{ command = $command; argv = $arguments.ToArray() } -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
  return JSON.parse(Buffer.from(powershellOutput(script), 'base64').toString('utf8'));
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
  // Electron's launchItems.args uses Chromium GetArgs(), which intentionally
  // omits --switches. Validate that projection, then independently validate
  // the actual Run command with Windows' native parser below.
  const settings = app.getLoginItemSettings({ path: `"${helper}"`, args: ['--config', manager.file] });
  const item = settings.launchItems?.find(value => value.name === RUN_VALUE_NAME && value.scope === 'user');
  assert(item, 'The custom current-user Run entry must be visible to real Electron');
  assert.equal(path.resolve(item.path).toLowerCase(), path.resolve(helper).toLowerCase(), 'Run executable must be the staged helper');
  assert.deepEqual(item.args, [manager.file], 'The positional configuration path must survive Electron quoting');
  const registered = registeredCommand();
  assert.equal(path.resolve(registered.argv[0]).toLowerCase(), path.resolve(helper).toLowerCase());
  assert.deepEqual(registered.argv.slice(1), ['--config', manager.file], 'The actual Run command must retain its flag and exact Unicode path');
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
  execFileSync(helper, ['--stop'], { windowsHide: true, stdio: 'pipe', timeout: 7000 });
  await waitFor(() => watcherCount() === 0, 'The fixture helper did not stop before Run-command validation');
  console.log('Auto-start fixture: replaying Windows-decoded Run command');
  const launched = registeredCommand();
  assert.deepEqual(launched.argv, [helper, '--config', manager.file]);
  // Launch the arguments decoded from the actual Run value without involving
  // a captured shell process or inheriting any of its long-lived pipe handles.
  await new Promise((resolve, reject) => {
    const child = spawn(launched.argv[0], launched.argv.slice(1), { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  await waitFor(() => watcherCount() === 1, 'Executing the actual Run command did not start the native helper');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(watcherCount(), 1, 'The registered command did not leave a valid watcher running');
  console.log('Auto-start fixture: Run command replay remains alive');

  // Simulate Task Manager's Startup tab using the exact native Electron API.
  console.log('Auto-start fixture: applying Task Manager disable');
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
  console.log('Auto-start fixture: Task Manager disable preserved and helper stopped');

  console.log('Auto-start fixture: explicitly re-enabling auto-start');
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
  cleanupVerified = true;
  console.log('Auto-start fixture: registration and cleanup assertions passed');
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
  console.log('Auto-start fixture: cleanup starting');
  if (manager && !cleanupVerified) {
    try {
      const state = await manager.reconcile(false, { explicit: true });
      if (state.status !== 'disabled' || registryValue(RUN) !== null || registryValue(APPROVED) !== null) throw new Error('Auto-start fixture cleanup failed');
      if (helper) await waitFor(() => watcherCount() === 0, 'Auto-start fixture cleanup left the native helper running');
      cleanupVerified = true;
    } catch (cleanupError) {
      const detail = String(cleanupError.message).slice(-1000);
      console.error('::error title=Auto-start fixture cleanup::' + detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
  if (!failed) console.log('Real Electron auto-start integration passed: HKCU registration, Unicode quoting, native helper, StartupApproved opt-out, explicit re-enable and cleanup');
  app.quit();
}
timer = setTimeout(() => { void finish(new Error('Real Electron auto-start integration timed out')); }, 65000);
void main().then(() => finish()).catch(finish);

'use strict';
// Synthetic, offline Chromium validation. It never opens real account data.
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = mkdtempSync(path.join(os.tmpdir(), 'codex-web-smoke-'));
let displayServer, child;
async function prepareDisplay() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return process.env.DISPLAY;
  if (!existsSync('/usr/lib/xorg/Xorg')) throw new Error('Xorg with the dummy video driver is required for Linux GUI validation');
  let number = 90;
  while (number < 200 && (existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`))) number++;
  if (number === 200) throw new Error('No free virtual display');
  const display = `:${number}`;
  displayServer = spawn('/usr/lib/xorg/Xorg', [display, '-config', path.join(__dirname, 'xorg-dummy.conf'), '-logfile', path.join(directory, 'Xorg.log'), '-nolisten', 'tcp', '-noreset', '-novtswitch'], { stdio: 'ignore' });
  let failed = false;
  displayServer.on('error', () => { failed = true; }); displayServer.on('exit', () => { failed = true; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failed) throw new Error('Virtual display startup failed');
    if (spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore', timeout: 1000 }).status === 0) return display;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Virtual display was not ready');
}
async function main() {
  const display = await prepareDisplay();
  const root = path.dirname(require.resolve('electron/package.json'));
  const executable = path.join(root, 'dist', readFileSync(path.join(root, 'path.txt'), 'utf8').trim());
  const args = [path.join(__dirname, 'web-smoke-electron.cjs'), '--synthetic-offline'];
  // This exception applies only to this explicit offline fixture harness.
  if (process.argv.includes('--cloud-no-sandbox')) args.unshift('--no-sandbox');
  const environment = { ...process.env, WEB_SMOKE_DIRECTORY: directory, ...(display ? { DISPLAY: display } : {}), XDG_CACHE_HOME: path.join(directory, 'cache') };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, args, { cwd: path.join(__dirname, '..'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  child.stdout.on('data', data => { output += data; process.stdout.write(data); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-6000); });
  const timer = setTimeout(() => { console.error('Web smoke timed out'); child.kill(); process.exitCode = 1; }, 40000);
  child.on('error', error => { clearTimeout(timer); displayServer?.kill(); console.error('Web smoke launch failed:', error.code); process.exitCode = 1; });
  child.on('exit', code => {
    clearTimeout(timer); displayServer?.kill();
    if (code !== 0 || !output.includes('Web smoke: passed')) { console.error('Web smoke failed:', code, diagnostics); process.exitCode = 1; }
    else console.log('Web screenshots:', path.join(directory, 'desktop.png'), path.join(directory, 'mobile.png'));
  });
}
void main().catch(error => { console.error(error.message); child?.kill(); displayServer?.kill(); process.exitCode = 1; });

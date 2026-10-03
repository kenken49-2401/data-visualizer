'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = mkdtempSync(path.join(os.tmpdir(), 'codex-usage-smoke-'));
const project = path.join(__dirname, '..');
const currentVersion = require('../package.json').version;
let expectedVersion = currentVersion;
const rollback = process.argv.includes('--rollback-update');
const staged = rollback || process.argv.includes('--staged-update');
if (staged) {
  const { FILES } = require('../src/updater.cjs');
  const parts = currentVersion.split('.').map(Number); parts[2]++;
  const version = parts.join('.');
  const destination = path.join(directory, 'updates', 'versions', version);
  for (const name of FILES) {
    let bytes = readFileSync(path.join(project, name));
    if (name === 'package.json' || name === 'package-lock.json') {
      const pkg = JSON.parse(bytes); pkg.version = version;
      if (pkg.packages) pkg.packages[''].version = version;
      bytes = Buffer.from(JSON.stringify(pkg));
    }
    const file = path.join(destination, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
  }
  symlinkSync(path.join(project, 'node_modules'), path.join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(destination, 'verified.json'), JSON.stringify({ version, sha256: '0'.repeat(64) }));
  writeFileSync(path.join(directory, 'updates', 'active.json'), JSON.stringify({ version, previousVersion: currentVersion }));
  if (rollback) writeFileSync(path.join(destination, 'src', 'main.cjs'), "require('electron').app.exit(17);\n");
  else expectedVersion = version;
}
let displayServer;
async function prepareDisplay() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return process.env.DISPLAY;
  const binary = '/usr/lib/xorg/Xorg';
  if (!existsSync(binary)) throw new Error('Xorg with the dummy video driver is required for Linux GUI validation');
  let number = 90;
  while (number < 200 && (existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`))) number++;
  if (number === 200) throw new Error('No free virtual display');
  const display = `:${number}`;
  displayServer = spawn(binary, [display, '-config', path.join(__dirname, 'xorg-dummy.conf'),
    '-logfile', path.join(directory, 'Xorg.log'), '-nolisten', 'tcp', '-noreset', '-novtswitch'],
  { stdio: 'ignore' });
  let failed = false;
  displayServer.on('error', () => { failed = true; });
  displayServer.on('exit', () => { failed = true; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failed) throw new Error('Virtual display startup failed');
    const check = spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore', timeout: 1000 });
    if (check.status === 0) return display;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Virtual display was not ready');
}

async function main() {
const display = await prepareDisplay();
const root = path.dirname(require.resolve('electron/package.json'));
let executable = path.join(root, 'dist', readFileSync(path.join(root, 'path.txt'), 'utf8').trim());
const args = ['.', '--demo', '--smoke'];
// This cloud host cannot run Chromium's SUID sandbox. Only the local demo smoke
// runner accepts this explicit switch. Normal npm start never disables it.
if (process.argv.includes('--cloud-no-sandbox')) args.unshift('--no-sandbox');
const environment = { ...process.env, ...(display ? { DISPLAY: display } : {}), CODEX_USAGE_RUNTIME_DIR: directory, XDG_CACHE_HOME: path.join(directory, 'cache') };
if (process.argv.includes('--launcher') || staged) {
  executable = process.execPath;
  args.splice(args.indexOf('.'), 1);
  args.unshift(path.join(__dirname, '..', 'launcher.cjs'));
  environment.ELECTRON_RUN_AS_NODE = '1';
} else delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: environment });
let output = '';
let diagnostics = '';
child.stdout.on('data', data => { output += data; process.stdout.write(data); });
child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-6000); });
child.on('error', error => { console.error('Electron launch failed:', error.code); process.exitCode = 1; displayServer?.kill(); });
const timer = setTimeout(() => { console.error('Renderer smoke timed out'); child.kill(); process.exitCode = 1; }, 30000);
child.on('exit', code => {
  clearTimeout(timer);
  displayServer?.kill();
  if (code !== 0 || !output.includes(`Renderer smoke: passed v${expectedVersion}`) || (rollback && !diagnostics.includes('restoring the previous version'))) {
    console.error('Renderer smoke failed:', code);
    console.error(diagnostics);
    process.exitCode = 1;
  } else console.log('Demo screenshot:', path.join(directory, 'demo.png'));
});
}
void main().catch(error => { console.error(error.message); displayServer?.kill(); process.exitCode = 1; });

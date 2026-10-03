'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const REPOSITORY = 'kenken49-2401/data-visualizer';
const BASE = `https://raw.githubusercontent.com/${REPOSITORY}/main/`;
const FILES = ['package.json', 'package-lock.json', 'launcher.cjs', 'start.cmd', 'README.md',
  'src/main.cjs', 'src/preload.cjs', 'src/usage.cjs', 'src/codex-client.cjs', 'src/usage-service.cjs',
  'src/settings.cjs', 'src/position.cjs', 'src/updater.cjs', 'src/windows-tracker.ps1',
  'src/ui/index.html', 'src/ui/style.css', 'src/ui/renderer.js', 'src/ui/tray.png'];
function versionParts(value) { return typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value.split('.').map(Number) : null; }
function newer(a, b) {
  const first = versionParts(a); const second = versionParts(b);
  if (!first || !second) return false;
  for (let i = 0; i < 3; i++) { if (first[i] !== second[i]) return first[i] > second[i]; }
  return false;
}
function storageDirectory(env = process.env) {
  if (env.CODEX_USAGE_RUNTIME_DIR) return path.join(env.CODEX_USAGE_RUNTIME_DIR, 'updates');
  const base = process.platform === 'win32' ? env.APPDATA : (env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  if (!base) throw new Error('Application data directory unavailable');
  return path.join(base, 'codex-usage-overlay', 'updates');
}
function fingerprint(lock) {
  const packages = { ...lock.packages };
  packages[''] = { ...packages[''] }; delete packages[''].name; delete packages[''].version;
  return createHash('sha256').update(JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages })).digest('hex');
}
function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || !versionParts(manifest.version) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || manifest.url !== `${BASE}updates/${manifest.version}.json`) {
    throw new Error('Invalid update manifest');
  }
  return manifest;
}
function validateBundle(bundle, version) {
  if (!bundle || bundle.schema !== 1 || bundle.version !== version || !bundle.files || typeof bundle.files !== 'object') throw new Error('Invalid bundle');
  const names = Object.keys(bundle.files);
  const safeSource = name => /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|js|css|html|ps1|json|png|svg|ico|woff2)$/.test(name) &&
    !name.split('/').some(segment => segment === '.' || segment === '..');
  if (names.length > 128 || FILES.some(name => !names.includes(name)) || names.some(name => !FILES.includes(name) && !safeSource(name))) throw new Error('Unexpected update files');
  const decoded = new Map();
  for (const name of names) {
    const entry = bundle.files[name];
    if (!entry || typeof entry.content !== 'string' || !['utf8', 'base64'].includes(entry.encoding)) throw new Error('Invalid file');
    if (entry.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) throw new Error('Invalid base64');
    decoded.set(name, Buffer.from(entry.content, entry.encoding));
  }
  const pkg = JSON.parse(decoded.get('package.json').toString());
  const lock = JSON.parse(decoded.get('package-lock.json').toString());
  if (pkg.name !== 'codex-usage-overlay' || pkg.version !== version || pkg.main !== 'src/main.cjs' ||
      lock.name !== pkg.name || lock.version !== version || lock.packages?.['']?.version !== version || lock.lockfileVersion !== 3) {
    throw new Error('Bundle package identity mismatch');
  }
  return decoded;
}
async function download(url, maximum, fetchFn = fetch) {
  const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('Update download unavailable');
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('Update too large');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error('Update too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function run(command, args, options = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output = (output + data.toString()).slice(-10000); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('Update preparation timed out')); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Update preparation failed')); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Update preparation failed')); });
  });
}
async function prepareDependencies(directory, currentRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  const currentLock = JSON.parse(fs.readFileSync(path.join(currentRoot, 'package-lock.json'), 'utf8'));
  const modules = path.join(currentRoot, 'node_modules');
  if (fingerprint(lock) === fingerprint(currentLock) && fs.existsSync(modules)) {
    // Reuse only identical dependency locks; version directories never overwrite the live source.
    fs.symlinkSync(modules, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    if (process.platform === 'win32') {
      await run(process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', 'npm.cmd ci'], { cwd: directory });
    } else await run('npm', ['ci'], { cwd: directory });
    await run(process.execPath, [path.join(directory, 'node_modules', 'electron', 'install.js')], {
      cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  }
  const electronRoot = path.dirname(require.resolve('electron/package.json', { paths: [directory] }));
  const binary = path.join(electronRoot, 'dist', fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim());
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-update-check-'));
  try {
    const checkEnv = { ...process.env, CODEX_USAGE_RUNTIME_DIR: runtime };
    delete checkEnv.ELECTRON_RUN_AS_NODE;
    const output = await run(binary, [directory, '--demo', '--smoke'], {
      env: checkEnv,
    }, 60000);
    if (!output.includes('Renderer smoke: passed')) throw new Error('Update startup verification failed');
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
}
function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
class UpdateManager extends EventEmitter {
  constructor({ currentRoot, directory = storageDirectory(), fetchFn = fetch, prepare = prepareDependencies }) {
    super(); this.currentRoot = currentRoot; this.directory = directory; this.fetchFn = fetchFn; this.prepare = prepare;
    this.version = JSON.parse(fs.readFileSync(path.join(currentRoot, 'package.json'), 'utf8')).version;
    this.state = { status: 'idle', version: this.version, available: null };
    this.inflight = null; this.timer = null;
  }
  publish(state) { this.state = { ...this.state, ...state }; this.emit('state', this.state); }
  start() { if (this.timer) return; void this.check(); this.timer = setInterval(() => void this.check(), 30 * 60 * 1000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async check() {
    if (this.inflight) return this.inflight;
    this.inflight = this.performCheck();
    try { return await this.inflight; } finally { this.inflight = null; }
  }
  async performCheck() {
    this.publish({ status: 'checking' });
    try {
      const manifest = validateManifest(JSON.parse((await download(`${BASE}update.json`, 64000, this.fetchFn)).toString()));
      if (!newer(manifest.version, this.version)) { this.publish({ status: 'current', available: null }); return; }
      // A prepared update can be reused without reinstallation on every poll.
      const target = path.join(this.directory, 'versions', manifest.version);
      const marker = path.join(target, 'verified.json');
      let ready = false;
      try { ready = JSON.parse(fs.readFileSync(marker, 'utf8')).sha256 === manifest.sha256; } catch {}
      if (!ready) {
        this.publish({ status: 'downloading', available: manifest.version });
        const bytes = await download(manifest.url, 2 * 1024 * 1024, this.fetchFn);
        if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Update checksum mismatch');
        const files = validateBundle(JSON.parse(bytes.toString()), manifest.version);
        fs.mkdirSync(path.join(this.directory, 'versions'), { recursive: true });
        const staging = fs.mkdtempSync(path.join(this.directory, 'versions', '.staging-'));
        try {
          for (const [name, content] of files) {
            const file = path.join(staging, name);
            fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
          }
          this.publish({ status: 'preparing' });
          await this.prepare(staging, this.currentRoot);
          atomicJson(path.join(staging, 'verified.json'), { version: manifest.version, sha256: manifest.sha256 });
          if (fs.existsSync(target)) throw new Error('An unverified version directory already exists');
          fs.renameSync(staging, target);
        } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
      }
      fs.mkdirSync(this.directory, { recursive: true });
      atomicJson(path.join(this.directory, 'active.json'), { version: manifest.version, previousVersion: this.version });
      this.publish({ status: 'ready', available: manifest.version });
    } catch { this.publish({ status: 'error' }); }
  }
}
module.exports = { UpdateManager, FILES, BASE, newer, validateManifest, validateBundle, fingerprint, storageDirectory };

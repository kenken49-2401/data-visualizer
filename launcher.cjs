'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { storageDirectory, newer } = require('./src/updater.cjs');
const root = __dirname;
const version = require('./package.json').version;
const directory = storageDirectory();
const waitArgument = process.argv.slice(2).find(value => /^--wait-for-pid=\d+$/.test(value));
const argumentsToPass = process.argv.slice(2).filter(value => value !== waitArgument);
let pointer;
try { pointer = JSON.parse(fs.readFileSync(path.join(directory, 'active.json'), 'utf8')); } catch {}
function release(versionToLoad) {
  if (!newer(versionToLoad, version)) return null;
  const candidate = path.join(directory, 'versions', versionToLoad);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(candidate, 'verified.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
    return marker.version === versionToLoad && /^[a-f0-9]{64}$/.test(marker.sha256) && pkg.version === versionToLoad && pkg.name === 'codex-usage-overlay' && pkg.main === 'src/main.cjs' && fs.existsSync(path.join(candidate, 'node_modules')) ? candidate : null;
  } catch { return null; }
}
function launch(selected, fallbackAllowed) {
  let binary;
  try {
    const electronRoot = path.dirname(require.resolve('electron/package.json', { paths: [selected] }));
    binary = path.join(electronRoot, 'dist', fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim());
  } catch { console.error('Dependencies are missing. Run start.cmd.'); process.exitCode = 1; return; }
  const started = Date.now();
  let rolledBack = false;
  const childEnv = { ...process.env, CODEX_USAGE_BOOTSTRAP_ROOT: root };
  // Electron treats even the string "0" as RunAsNode. It must be absent for GUI startup.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [selected, ...argumentsToPass], { stdio: 'inherit', windowsHide: true, env: childEnv });
  const rollback = () => {
    if (rolledBack) return;
    rolledBack = true;
    if (fallbackAllowed) {
      try { fs.renameSync(path.join(directory, 'active.json'), path.join(directory, `failed-${Date.now()}.json`)); } catch {}
      const previous = release(pointer?.previousVersion) || root;
      if (previous !== root) {
        try { fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ version: pointer.previousVersion, previousVersion: version })); } catch {}
      }
      console.error('The update did not start; restoring the previous version.');
      launch(previous, false);
    } else process.exitCode = 1;
  };
  child.on('error', rollback);
  child.on('exit', code => {
    if (rolledBack) return;
    if (code !== 0 && Date.now() - started < 30000) rollback();
    else process.exitCode = code || 0;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
}
async function main() {
  if (waitArgument) {
    const pid = Number(waitArgument.split('=')[1]);
    let gone = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(pid, 0); } catch { gone = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!gone) { console.error('Previous application did not stop.'); process.exitCode = 1; return; }
  }
  launch(release(pointer?.version) || root, Boolean(release(pointer?.version)));
}
void main();

'use strict';
// Keep Chromium diagnostics separate from PowerShell's native-error handling.
// The child fixture gates all registry changes to isolated Windows CI runs.
const { spawn } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  console.error('The startup registration smoke runs only on Windows GitHub Actions');
  process.exitCode = 1;
} else {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(__dirname, 'autostart-electron-smoke.cjs'), '--synthetic-autostart'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment
  });
  let output = '', diagnostics = '', timedOut = false;
  child.stdout.on('data', data => { output = (output + data).slice(-12000); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
  function failure(message) {
    console.error(message);
    console.error('::error title=Windows startup registration diagnostics::' + message.slice(-11000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
    process.exitCode = 1;
  }
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  child.once('error', error => { clearTimeout(timer); failure(`Cannot start the registry fixture: ${error.message}`); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (output) process.stdout.write(output);
    if (timedOut || code !== 0 || !output.includes('Real Electron auto-start integration passed')) {
      failure(`exit=${code}; signal=${signal}; timedOut=${timedOut}; stdout=${output.slice(-5000)}; stderr=${diagnostics.slice(-5500)}`);
    }
  });
}

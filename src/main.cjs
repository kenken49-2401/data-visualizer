'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync, mkdirSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { CodexClient } = require('./codex-client.cjs');
const { UsageService } = require('./usage-service.cjs');
const { demoUsage, publicError } = require('./usage.cjs');
const { bottomLeft } = require('./position.cjs');

const demo = process.argv.includes('--demo');
const smoke = process.argv.includes('--smoke');
const runtimeDirectory = process.env.CODEX_USAGE_RUNTIME_DIR;
if (runtimeDirectory) {
  // Allows development in read-only home directories; this contains no Codex credentials.
  mkdirSync(runtimeDirectory, { recursive: true });
  app.setPath('userData', runtimeDirectory);
  app.setPath('sessionData', path.join(runtimeDirectory, 'session'));
}
if (smoke) {
  app.commandLine.appendSwitch('disable-gpu');
}

let window;
let tray;
let tracker;
let service;
let client;
let loginPending = false;
let loginId = null;
let loginTimer;
let mode = process.platform === 'win32' ? 'follow' : 'screen';
let tracked = null;
let trackerFailed = false;
let state = demo
  ? { status: 'demo', usage: demoUsage(), updatedAt: Date.now(), error: null }
  : { status: 'loading', usage: null, updatedAt: null, error: null };
const size = { width: 354, height: 260 };
const pageUrl = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;

function notify() {
  if (!window?.isDestroyed() && !window.webContents.isLoading()) {
    window.webContents.send('usage:state', { ...state, mode,
      placement: mode === 'follow' && tracked?.present && !trackerFailed ? 'app' : 'screen',
      trackerFailed, loginPending });
  }
}

function place() {
  if (!window || window.isDestroyed()) return;
  if (mode === 'follow' && tracked?.present && !trackerFailed) {
    if (!tracked.active || tracked.minimized) { window.hide(); return; }
    const physical = { x: tracked.x, y: tracked.y, width: tracked.width, height: tracked.height };
    const dip = screen.screenToDipRect(null, physical);
    window.setBounds(bottomLeft(dip, size));
  } else {
    window.setBounds(bottomLeft(screen.getPrimaryDisplay().workArea, size));
  }
  if (!smoke) window.showInactive();
  notify();
}

function setMode(next) { mode = next; place(); buildMenu(); }

function buildMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '今すぐ更新', enabled: !demo, click: () => void service?.refresh() },
    { label: 'ChatGPT アカウントでログイン', enabled: !demo, click: () => void login() },
    { type: 'separator' },
    { label: 'ChatGPT / Codex の左下に追従', type: 'radio', checked: mode === 'follow', enabled: process.platform === 'win32', click: () => setMode('follow') },
    { label: '画面左下に常に表示', type: 'radio', checked: mode === 'screen', click: () => setMode('screen') },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]));
}

function validLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

async function login() {
  if (demo || loginPending) return;
  loginPending = true;
  notify();
  try {
    const result = await client.request('account/login/start', { type: 'chatgpt' });
    if (!validLoginUrl(result?.authUrl)) throw new Error('Unexpected login destination');
    loginId = result.loginId;
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => { void cancelLogin(); }, 10 * 60 * 1000);
    await shell.openExternal(result.authUrl);
    // Completion is sent by app-server after its local OAuth callback.
  } catch (error) {
    loginPending = false;
    clearTimeout(loginTimer);
    state = { status: 'error', usage: null, updatedAt: null, error: publicError(error) };
    notify();
  }
}

async function cancelLogin() {
  const id = loginId;
  loginId = null;
  loginPending = false;
  clearTimeout(loginTimer);
  notify();
  if (id && client) {
    try { await client.request('account/login/cancel', { loginId: id }); } catch { /* may already have completed */ }
    void service?.refresh();
  }
}

function startTracker() {
  if (process.platform !== 'win32' || smoke) return;
  // Pass a fixed local script through stdin, avoiding command interpolation and global policy changes.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  tracker = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const failed = () => { trackerFailed = true; place(); };
  tracker.on('error', failed);
  tracker.on('exit', failed);
  tracker.stdin.on('error', failed);
  tracker.stderr.on('data', () => {});
  createInterface({ input: tracker.stdout }).on('line', line => {
    try {
      const value = JSON.parse(line);
      if (typeof value.present !== 'boolean' || typeof value.active !== 'boolean' || typeof value.minimized !== 'boolean') return;
      if (value.present && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) return;
      if (value.present && (value.width <= 0 || value.height <= 0)) return;
      tracked = value;
      place();
    } catch { /* PowerShell diagnostics are never used as UI text */ }
  });
  tracker.stdin.end(readFileSync(path.join(__dirname, 'windows-tracker.ps1'), 'utf8'));
}

function guard(event) { if (event.sender !== window?.webContents || event.senderFrame?.url !== pageUrl) throw new Error('Unexpected sender'); }

async function smokeCheck() {
  const result = await window.webContents.executeJavaScript(`(() => {
    const five = document.querySelector('[data-window="fiveHour"] .value').textContent;
    const weekly = document.querySelector('[data-window="weekly"] .value').textContent;
    const demo = document.querySelector('#status').textContent;
    const secure = typeof require === 'undefined' && typeof process === 'undefined';
    const fits = document.documentElement.scrollHeight <= window.innerHeight && document.querySelector('footer').getBoundingClientRect().bottom <= window.innerHeight;
    return { five, weekly, demo, secure, fits };
  })()`);
  if (result.five !== '72%' || result.weekly !== '41%' || !result.demo.includes('デモ') || !result.secure || !result.fits) {
    throw new Error('Renderer smoke check failed');
  }
  const safePath = path.join(app.getPath('userData'), 'demo.png');
  const { writeFileSync } = require('node:fs');
  writeFileSync(safePath, (await window.webContents.capturePage()).toPNG());
  // Exercise error rendering through the real preload subscription.
  state = { status: 'error', usage: null, updatedAt: null, error: { kind: 'auth', text: '同じ Plus アカウントでログインしてください' } };
  notify();
  await new Promise(resolve => setTimeout(resolve, 100));
  const empty = await window.webContents.executeJavaScript(`document.querySelector('[data-window="fiveHour"] .value').textContent === '—' && !document.querySelector('#login').hidden`);
  if (!empty) throw new Error('Auth error smoke check failed');
  state = { status: 'ready', usage: demoUsage(), updatedAt: Date.now() - 180000, error: null };
  notify();
  await new Promise(resolve => setTimeout(resolve, 100));
  const stale = await window.webContents.executeJavaScript(`document.body.dataset.status === 'stale' && document.querySelector('#status').textContent.includes('前回の取得値')`);
  if (!stale) throw new Error('Stale snapshot smoke check failed');
  console.log('Renderer smoke: passed (demo, values, layout, isolated preload, auth error, stale snapshot)');
  app.quit();
}

if (!app.requestSingleInstanceLock() && !smoke) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) window.showInactive(); });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ ...size, frame: false, resizable: false, maximizable: false,
      minimizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
      show: false, backgroundColor: '#10191b',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    window.setAlwaysOnTop(true, 'floating');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', notify);
    ipcMain.handle('usage:get', event => { guard(event); return { ...state, mode, placement: 'screen', trackerFailed, loginPending }; });
    ipcMain.handle('usage:refresh', event => { guard(event); if (!demo) return service?.refresh(); });
    ipcMain.handle('usage:login', event => { guard(event); return login(); });
    ipcMain.handle('usage:cancel-login', event => { guard(event); return cancelLogin(); });
    ipcMain.handle('usage:mode', (event, next) => { guard(event); if (next === 'screen' || (next === 'follow' && process.platform === 'win32')) setMode(next); });
    ipcMain.handle('usage:quit', event => { guard(event); app.quit(); });
    if (!smoke) {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png')));
      tray.setToolTip('Codex 残り使用量');
      buildMenu();
      tray.on('click', () => { window.showInactive(); notify(); });
    }
    await window.loadFile(path.join(__dirname, 'ui', 'index.html'));
    place();
    if (demo) {
      if (smoke) { await new Promise(resolve => setTimeout(resolve, 200)); await smokeCheck(); }
      return;
    }
    client = new CodexClient();
    service = new UsageService(client);
    service.on('state', next => { state = next; notify(); });
    client.on('notification', (method, params) => {
      if (method === 'account/login/completed') {
        loginPending = false;
        loginId = null;
        clearTimeout(loginTimer);
        if (params?.success === false) {
          state = { status: 'error', usage: null, updatedAt: null,
            error: { kind: 'auth', text: 'ログインが完了しませんでした。もう一度お試しください' } };
        }
        notify();
      }
    });
    client.on('disconnected', () => { loginPending = false; loginId = null; clearTimeout(loginTimer); notify(); });
    service.start();
    startTracker();
    screen.on('display-metrics-changed', place);
    screen.on('display-added', place);
    screen.on('display-removed', place);
  }).catch(() => { console.error('Overlay startup failed'); app.exit(1); });
}

app.on('before-quit', () => { clearTimeout(loginTimer); service?.stop(); tracker?.kill(); tray?.destroy(); });
app.on('window-all-closed', () => app.quit());

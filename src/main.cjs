'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, session, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { CodexClient } = require('./codex-client.cjs');
const { UsageService } = require('./usage-service.cjs');
const { demoUsage, publicError } = require('./usage.cjs');
const { bottomLeft, keepOnScreen } = require('./position.cjs');
const { SettingsStore, SIZES } = require('./settings.cjs');
const { UpdateManager } = require('./updater.cjs');
const { visibleForChatGPT } = require('./visibility.cjs');
const { InstallerUpdater } = require('./installer-updater.cjs');
const { matchesDocument } = require('./document-origin.cjs');
const version = require('../package.json').version;
const demo = process.argv.includes('--demo');
const smoke = process.argv.includes('--smoke');
app.setName('codex-usage-overlay');
// Keep settings shared with the ZIP version; the product's display name differs.
app.setPath('userData', path.join(app.getPath('appData'), 'codex-usage-overlay'));
if (process.platform === 'win32') app.setAppUserModelId('com.kenken49.codex-usage-overlay');
if (process.env.CODEX_USAGE_RUNTIME_DIR) {
  mkdirSync(process.env.CODEX_USAGE_RUNTIME_DIR, { recursive: true });
  app.setPath('userData', process.env.CODEX_USAGE_RUNTIME_DIR);
  app.setPath('sessionData', path.join(process.env.CODEX_USAGE_RUNTIME_DIR, 'session'));
}
if (smoke) app.commandLine.appendSwitch('disable-gpu');
const pageFile = path.join(__dirname, 'ui', 'index.html');
let window, tray, tracker, service, client, store, updater, savePositionTimer, loginTimer;
let settings, tracked = null, trackerFailed = false;
let loginPending = false, loginId = null, userHidden = false, userMinimized = false;
let state = demo ? { status: 'demo', usage: demoUsage(), updatedAt: Date.now(), error: null }
  : { status: 'loading', usage: null, updatedAt: null, error: null };

function model() {
  return { ...state, settings, version, loginPending, trackerFailed, settingsError: store?.error,
    placement: settings?.mode === 'follow' && tracked?.present && !trackerFailed ? 'app' : settings?.mode === 'manual' ? 'manual' : 'screen',
    update: updater?.state ?? { status: 'idle', version, available: null } };
}
function notify() {
  if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send('usage:state', model());
  if (tray) {
    const quota = state.usage;
    const value = entry => entry ? `${Math.round(entry.remainingPercent)}%` : '—';
    tray.setToolTip(`Codex 残り使用量 · 5h ${value(quota?.fiveHour)} / 7d ${value(quota?.weekly)}${state.status === 'stale' ? '（前回取得値）' : ''}`);
  }
}
function updateSettings(patch) {
  settings = store.update(patch);
  service?.setIntervalMs(settings.intervalSeconds * 1000);
  if (updater) settings.autoUpdates ? updater.start() : updater.stop();
  window?.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  place(); buildMenu(); notify();
}
function setAutomaticVisibility(visible) {
  // Keep the running taskbar button while the panel is suppressed.
  // An invisible panel must never intercept clicks on ChatGPT or other apps.
  window.setOpacity(visible ? 1 : 0);
  window.setIgnoreMouseEvents(!visible);
  if (!smoke && !userHidden && !userMinimized) window.showInactive();
}
function place(force = false) {
  if (!window || window.isDestroyed()) return;
  if (!demo && process.platform === 'win32' && !visibleForChatGPT(settings, tracked, trackerFailed)) { setAutomaticVisibility(false); notify(); return; }
  setAutomaticVisibility(true);
  const size = SIZES[settings.size];
  let bounds;
  if (settings.mode === 'manual' && settings.x !== null && settings.y !== null) {
    bounds = { ...size, x: settings.x, y: settings.y };
  } else if (settings.mode === 'follow' && tracked?.present && !trackerFailed) {
    if (!settings.chatgptOnly && !force && (!tracked.active || tracked.minimized)) { setAutomaticVisibility(false); notify(); return; }
    const physical = { x: tracked.x, y: tracked.y, width: tracked.width, height: tracked.height };
    bounds = bottomLeft(screen.screenToDipRect(null, physical), size);
    bounds.x += settings.offsetX; bounds.y += settings.offsetY;
  } else {
    bounds = bottomLeft(screen.getPrimaryDisplay().workArea, size);
    bounds.x += settings.offsetX; bounds.y += settings.offsetY;
  }
  bounds = keepOnScreen(bounds, screen.getDisplayMatching(bounds).workArea);
  window.setBounds(bounds);
  if (!smoke && !userHidden && !userMinimized) window.showInactive();
  notify();
}
function hide() { userHidden = true; window.hide(); buildMenu(); }
function minimize() { userMinimized = true; window.setFocusable(true); window.setSkipTaskbar(false); window.minimize(); buildMenu(); }
function restore() {
  userHidden = false; userMinimized = false;
  if (window.isMinimized()) window.restore();
  window.setFocusable(true); window.setSkipTaskbar(false); place(true); buildMenu();
}
function nudge(dx, dy) {
  if (settings.mode === 'manual') {
    const current = window.getBounds(); updateSettings({ x: current.x + dx, y: current.y + dy });
  } else updateSettings({ offsetX: settings.offsetX + dx, offsetY: settings.offsetY + dy });
}
function selectMode(mode) {
  if (mode === 'manual') { const current = window.getBounds(); updateSettings({ mode, x: current.x, y: current.y }); }
  else updateSettings({ mode });
}
function contextMenu() {
  return Menu.buildFromTemplate([
    { label: userHidden || userMinimized ? '表示する' : '非表示にする', click: () => userHidden || userMinimized ? restore() : hide() },
    { label: '最小化する', click: minimize },
    { type: 'separator' },
    { label: '表示位置', submenu: [
      { label: '画面左下', type: 'radio', checked: settings.mode === 'screen', click: () => selectMode('screen') },
      { label: 'ChatGPT に追従', type: 'radio', enabled: process.platform === 'win32', checked: settings.mode === 'follow', click: () => selectMode('follow') },
      { label: '自由にドラッグ', type: 'radio', checked: settings.mode === 'manual', click: () => selectMode('manual') },
      { type: 'separator' },
      ...[['← 10px', -10, 0], ['→ 10px', 10, 0], ['↑ 10px', 0, -10], ['↓ 10px', 0, 10]].map(([label, dx, dy]) => ({ label, click: () => nudge(dx, dy) })),
      { label: '位置を初期化', click: () => { userHidden = false; updateSettings({ mode: 'screen', x: null, y: null, offsetX: 0, offsetY: 0 }); } },
    ] },
    { label: '表示する画面', submenu: screen.getAllDisplays().map((display, index) => ({
      label: `画面 ${index + 1}${display.id === screen.getPrimaryDisplay().id ? '（メイン）' : ''}`,
      click: () => { const b = bottomLeft(display.workArea, SIZES[settings.size]); updateSettings({ mode: 'manual', x: b.x, y: b.y }); },
    })) },
    { label: '大きさ', submenu: [['tiny', '最小'], ['compact', 'コンパクト'], ['comfortable', 'ゆったり']].map(([size, label]) => ({ label, type: 'radio', checked: settings.size === size, click: () => updateSettings({ size }) })) },
    { label: 'ChatGPTが最前面のときだけ表示', type: 'checkbox', checked: settings.chatgptOnly, enabled: process.platform === 'win32', click: item => updateSettings({ chatgptOnly: item.checked }) },
    { label: '最前面に表示', type: 'checkbox', checked: settings.alwaysOnTop, click: item => updateSettings({ alwaysOnTop: item.checked }) },
    { type: 'separator' },
    { label: '使用量の更新間隔', submenu: [60, 120, 180, 300].map(seconds => ({ label: `${seconds / 60}分`, type: 'radio', checked: settings.intervalSeconds === seconds, click: () => updateSettings({ intervalSeconds: seconds }) })) },
    { label: '今すぐ使用量を更新', enabled: !demo, click: () => void service?.refresh() },
    { label: 'ChatGPT アカウントでログイン', enabled: !demo, click: () => void login() },
    { type: 'separator' },
    { label: 'アプリを自動更新', type: 'checkbox', checked: settings.autoUpdates, enabled: !demo, click: item => updateSettings({ autoUpdates: item.checked }) },
    { label: 'アプリの更新を確認', enabled: !demo, click: () => void updater?.check() },
    { label: '更新を適用して再起動', enabled: updater?.state.status === 'ready', click: restart },
    { label: `バージョン ${version}`, enabled: false },
    { label: 'GitHub を開く', click: () => void shell.openExternal('https://github.com/kenken49-2401/data-visualizer') },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
}
function buildMenu() { if (tray) tray.setContextMenu(contextMenu()); }
function restart() {
  if (updater?.state.status !== 'ready') return;
  if (app.isPackaged) { updater.install(); return; }
  const bootstrap = process.env.CODEX_USAGE_BOOTSTRAP_ROOT || path.join(__dirname, '..');
  const child = spawn(process.execPath, [path.join(bootstrap, 'launcher.cjs'), `--wait-for-pid=${process.pid}`], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', () => {}); child.unref(); app.quit();
}
function validLoginUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && (!url.port || url.port === '443'); }
  catch { return false; }
}
async function login() {
  if (demo || loginPending) return;
  loginPending = true; notify();
  try {
    const result = await client.request('account/login/start', { type: 'chatgpt' });
    if (!validLoginUrl(result?.authUrl)) throw new Error('Unexpected login destination');
    loginId = result.loginId; clearTimeout(loginTimer);
    loginTimer = setTimeout(() => void cancelLogin(), 10 * 60 * 1000);
    await shell.openExternal(result.authUrl);
  } catch (error) {
    loginPending = false; clearTimeout(loginTimer);
    state = { status: 'error', usage: null, updatedAt: null, error: publicError(error) }; notify();
  }
}
async function cancelLogin() {
  const id = loginId; loginId = null; loginPending = false; clearTimeout(loginTimer); notify();
  if (id && client) { try { await client.request('account/login/cancel', { loginId: id }); } catch {} void service?.refresh(); }
}
function startTracker() {
  if (process.platform !== 'win32' || smoke || demo) return;
  const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `$ProgressPreference = 'SilentlyContinue'\n$usageOverlayOwnerId = ${process.pid}\n` + readFileSync(path.join(__dirname, 'windows-tracker.ps1'), 'utf8');
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  tracker = spawn(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const failed = () => { trackerFailed = true; place(); };
  let receivedAt = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - receivedAt > 5000) failed(); }, 1000);
  tracker.once('exit', () => clearInterval(watchdog));
  tracker.on('error', failed); tracker.on('exit', failed); tracker.stderr.on('data', () => {});
  createInterface({ input: tracker.stdout }).on('line', line => {
    try {
      const value = JSON.parse(line);
      if (typeof value.present !== 'boolean' || typeof value.active !== 'boolean' || typeof value.minimized !== 'boolean') return;
      if (value.present && (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0)) return;
      receivedAt = Date.now(); trackerFailed = false; tracked = value; place();
    } catch {}
  });
}
function guard(event) {
  const frame = event.senderFrame;
  const mainFrame = window?.webContents.mainFrame;
  if (event.sender !== window?.webContents || !frame || !mainFrame || frame.processId !== mainFrame.processId ||
      frame.routingId !== mainFrame.routingId || !matchesDocument(frame.url, pageFile)) throw new Error('Unexpected sender');
}
async function smokeCheck() {
  const wait = () => new Promise(resolve => setTimeout(resolve, 120));
  for (const size of ['compact', 'tiny', 'comfortable']) {
    updateSettings({ size }); await wait();
    const valid = await window.webContents.executeJavaScript(`(() => {
      const five = document.querySelector('[data-window="fiveHour"] .value').textContent;
      const week = document.querySelector('[data-window="weekly"] .value').textContent;
      return five === '72%' && week === '41%' && document.querySelector('#status').textContent.includes('デモ') &&
        typeof require === 'undefined' && typeof process === 'undefined' &&
        document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight &&
        getComputedStyle(document.querySelector('main')).borderTopLeftRadius !== '0px';
    })()`);
    if (!valid) throw new Error(`Renderer layout failed: ${size}`);
  }
  // Exercise both quotas at the exact boundaries in the actual renderer.
  for (const [percent, level, color] of [[30.1, 'normal', 'rgb(75, 145, 255)'], [30, 'warning', 'rgb(244, 197, 80)'], [10.1, 'warning', 'rgb(244, 197, 80)'], [10, 'critical', 'rgb(241, 105, 105)'], [0, 'critical', 'rgb(241, 105, 105)']]) {
    state = { status: 'demo', usage: demoUsage(), updatedAt: Date.now(), error: null };
    for (const quota of Object.values(state.usage)) { if (quota && typeof quota === 'object' && 'remainingPercent' in quota) quota.remainingPercent = percent; }
    notify(); await wait();
    const valid = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.quota')).every(q => q.dataset.level === '${level}' && getComputedStyle(q.querySelector('.fill')).backgroundColor === '${color}')`);
    if (!valid) throw new Error(`Quota warning color failed: ${percent}`);
  }
  state = { status: 'demo', usage: demoUsage(), updatedAt: Date.now(), error: null }; notify();
  updateSettings({ size: 'compact' }); await wait();
  writeFileSync(path.join(app.getPath('userData'), 'demo.png'), (await window.webContents.capturePage()).toPNG());
  state = { status: 'error', usage: null, updatedAt: null, error: { kind: 'auth', text: '同じ Plus アカウントでログインしてください' } };
  notify(); await wait();
  if (!await window.webContents.executeJavaScript(`document.querySelector('[data-window="fiveHour"] .value').textContent === '—' && !document.querySelector('#login').hidden`)) throw new Error('Auth error display failed');
  state = { status: 'ready', usage: demoUsage(), updatedAt: Date.now() - 180000, error: null }; notify(); await wait();
  if (!await window.webContents.executeJavaScript(`document.body.dataset.status === 'stale' && document.querySelector('#status').textContent.includes('前回')`)) throw new Error('Stale display failed');
  await window.webContents.executeJavaScript(`document.querySelector('#hide').click()`);
  await wait();
  if (!userHidden) throw new Error('Hide action failed');
  place(); if (window.isVisible()) throw new Error('Background refresh restored a hidden panel');
  restore();
  if (process.platform === 'win32') {
    window.showInactive(); setAutomaticVisibility(false); await wait();
    if (!window.isVisible() || window.getOpacity() !== 0 || !window.isFocusable()) throw new Error('Suppressed panel lost its taskbar window');
    setAutomaticVisibility(true); await wait();
    if (window.getOpacity() !== 1) throw new Error('Panel failed to reappear');
  }
  writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify({ version, passed: true }));
  console.log(`Renderer smoke: passed v${version} (three sizes, values, isolation, rounded layout, auth error, stale snapshot, hide/restore)`); app.quit();
}
if (!app.requestSingleInstanceLock() && !smoke) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) restore(); });
  app.whenReady().then(async () => {
    store = new SettingsStore(app.getPath('userData')); settings = store.value;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ ...SIZES[settings.size], frame: false, transparent: true, roundedCorners: true,
      resizable: false, maximizable: false, minimizable: true, skipTaskbar: false,
      alwaysOnTop: settings.alwaysOnTop, focusable: true, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', notify);
    window.on('will-move', () => { const current = window.getBounds(); settings = store.update({ mode: 'manual', x: current.x, y: current.y }); buildMenu(); notify(); });
    window.on('move', () => {
      if (settings.mode !== 'manual') return;
      clearTimeout(savePositionTimer); savePositionTimer = setTimeout(() => {
        if (!window.isDestroyed()) { const current = window.getBounds(); settings = store.update({ x: current.x, y: current.y }); notify(); }
      }, 250);
    });
    window.on('minimize', () => { userMinimized = true; });
    window.on('restore', () => { userMinimized = false; userHidden = false; window.setFocusable(true); window.setSkipTaskbar(false); });
    const handler = (name, fn) => ipcMain.handle(name, (event, ...args) => { guard(event); return fn(...args); });
    handler('usage:get', model);
    handler('usage:refresh', () => { if (!demo) return service?.refresh(); });
    handler('usage:login', login); handler('usage:cancel-login', cancelLogin);
    handler('usage:hide', hide); handler('usage:minimize', minimize); handler('usage:quit', () => app.quit());
    handler('usage:menu', () => contextMenu().popup({ window }));
    handler('usage:restart', restart);
    if (!smoke) {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png'))); buildMenu(); notify();
      tray.on('click', restore);
    }
    await window.loadFile(path.join(__dirname, 'ui', 'index.html')); place();
    if (demo) { if (smoke) { await new Promise(resolve => setTimeout(resolve, 200)); await smokeCheck(); } return; }
    client = new CodexClient(); service = new UsageService(client, { intervalMs: settings.intervalSeconds * 1000 });
    service.on('state', next => { state = next; notify(); });
    client.on('notification', (method, params) => {
      if (method === 'account/login/completed') {
        loginPending = false; loginId = null; clearTimeout(loginTimer);
        if (params?.success === false) state = { status: 'error', usage: null, updatedAt: null, error: { kind: 'auth', text: 'ログインが完了しませんでした。もう一度お試しください' } };
        notify();
      }
    });
    client.on('disconnected', () => { loginPending = false; loginId = null; clearTimeout(loginTimer); notify(); });
    updater = app.isPackaged ? new InstallerUpdater(require('electron-updater').autoUpdater, version)
      : new UpdateManager({ currentRoot: path.join(__dirname, '..'), directory: path.join(app.getPath('userData'), 'updates') });
    updater.on('state', () => { buildMenu(); notify(); });
    if (settings.autoUpdates) updater.start();
    service.start(); startTracker();
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, () => place());
    powerMonitor.on('resume', () => { void service.refresh(); if (settings.autoUpdates) void updater.check(); place(); });
  }).catch(error => { console.error(smoke ? error.message : 'Overlay startup failed'); app.exit(1); });
}
app.on('before-quit', () => { clearTimeout(loginTimer); clearTimeout(savePositionTimer); service?.stop(); updater?.stop(); tracker?.kill(); tray?.destroy(); });
app.on('window-all-closed', () => app.quit());

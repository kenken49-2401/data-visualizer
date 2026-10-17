'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { derive, seal } = require('../src/cloud-crypto.cjs');
if (!process.argv.includes('--synthetic-offline') || !process.env.WEB_SMOKE_DIRECTORY) throw new Error('This harness requires the synthetic offline fixture runner');
const directory = process.env.WEB_SMOKE_DIRECTORY;
mkdirSync(path.join(directory, 'profile'), { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
const master = 'a'.repeat(64), view = derive(master, 'history'), account = 'c'.repeat(64), archiveId = 'd'.repeat(32);
const DAY = 86400000, now = Date.now(), day = at => new Date(at).toISOString().slice(0, 10);
const points = [
  { at: now - 600000, fiveHour: 70, weekly: 80, gapMs: 1210000 },
  { at: now - 300000, fiveHour: 30, weekly: 10, gapMs: 1210000 }
];
const latest = { schema: 1, status: 'ready', account, points, recordedAt: points.at(-1).at, archive: { id: archiveId, firstDay: day(now - 2 * DAY), lastDay: day(now) } };
const fixtures = new Map([['history.enc.json', seal(latest, view, 'history')]]);
for (const at of [now - 2 * DAY, now - DAY, now]) {
  const date = day(at), daily = at === now ? points : [{ at, fiveHour: 90, weekly: 85, gapMs: 1210000 }];
  fixtures.set(`archive/${archiveId}/${date}.enc.json`, seal({ schema: 1, account, day: date, points: daily }, view, 'history-archive'));
}
const requests = [], errors = [];
let server, window;
const evaluate = source => window.webContents.executeJavaScript(source, true);
async function waitFor(source, message) {
  const end = Date.now() + 6500;
  while (Date.now() < end) { if (await evaluate(source)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function unlock(value) {
  await evaluate(`document.querySelector('#recording-key').value=${JSON.stringify(value)};document.querySelector('#unlock-form').requestSubmit()`);
}
async function main() {
  await app.whenReady();
  server = createServer((request, response) => {
    const file = new URL(request.url, 'http://127.0.0.1').pathname;
    const allowed = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.mjs', 'app.mjs'], ['/data.mjs', 'data.mjs'], ['/icon.svg', 'icon.svg']]);
    if (!allowed.has(file)) { response.writeHead(404); response.end(); return; }
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(readFileSync(path.join(__dirname, '..', 'web', allowed.get(file))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.origin !== origin && url.hostname !== 'raw.githubusercontent.com' });
  });
  await session.defaultSession.protocol.handle('https', request => {
    requests.push({ url: request.url, headers: [...request.headers] });
    const url = new URL(request.url), prefix = '/kenken49-2401/data-visualizer/usage-records/';
    if (url.hostname !== 'raw.githubusercontent.com' || !url.pathname.startsWith(prefix)) throw new Error('Unexpected external request');
    const name = url.pathname.slice(prefix.length), body = fixtures.get(name);
    return new Response(body ?? '', { status: body ? 200 : 404, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
  });
  window = new BrowserWindow({ width: 1280, height: 1120, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error' || details.level === 3) errors.push(details.message); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer process ${details.reason}`));
  await window.loadURL(origin);
  await waitFor(`document.querySelector('#demo') && document.querySelector('#timezone').textContent.length>0`, 'Dashboard did not initialize');
  assert.equal(await evaluate(`window.isSecureContext && Boolean(crypto.subtle)`), true);
  assert.equal(await evaluate(`document.querySelector('#dashboard').hidden && document.querySelector('#five-value').textContent==='—' && document.querySelectorAll('.dot').length===0`), true);
  assert.equal(requests.length, 0, 'Locked page must not request quota data');
  await click('#demo');
  await waitFor(`!document.querySelector('#demo-notice').hidden && document.querySelectorAll('.dot').length>20`, 'Explicit demo did not draw');
  await click('[data-days="7"]');
  assert.equal(await evaluate(`document.querySelector('[data-days="7"]').getAttribute('aria-pressed')==='true'`), true);
  await evaluate(`document.querySelector('#end-date').value='2026-01-15';document.querySelector('#end-date').dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('#range-label').textContent.includes('2026/01/15')`, 'Historical date did not apply');
  assert.equal(requests.length, 0, 'Demo must not request actual records');
  await click('#lock');
  assert.equal(await evaluate(`document.querySelector('#dashboard').hidden && document.querySelector('#five-value').textContent==='—' && document.querySelectorAll('.dot').length===0 && !document.querySelector('#recording-key').value && localStorage.length===0 && sessionStorage.length===0`), true, 'Lock must remove keys, values and charts');
  await unlock('view:' + 'b'.repeat(64));
  await waitFor(`document.querySelector('#unlock-error').textContent.length>0 && !document.querySelector('#unlock').disabled`, 'Wrong key was not rejected');
  assert.equal(await evaluate(`document.querySelector('#dashboard').hidden`), true);
  await unlock('view:' + view.toString('hex'));
  await waitFor(`!document.querySelector('#dashboard').hidden && document.querySelector('#five-value').textContent==='30%' && document.querySelectorAll('.dot').length>0 && !document.querySelector('#refresh').disabled`, 'Read-only key did not decrypt real-shaped fixture');
  assert.equal(await evaluate(`document.querySelector('#five-value').classList.contains('warning') && document.querySelector('#week-value').classList.contains('critical') && document.querySelector('#demo-notice').hidden`), true);
  await click('#latest');
  await waitFor(`!document.querySelector('#refresh').disabled && document.querySelectorAll('.dot').length>=4`, 'Latest view did not load');
  assert(requests.some(item => item.url.includes('/archive/')), 'Expected authenticated archive request');
  writeFileSync(path.join(directory, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(390, 1000);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'Mobile page overflows horizontally');
  writeFileSync(path.join(directory, 'mobile.png'), (await window.webContents.capturePage()).toPNG());
  const download = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CSV download timed out')), 6000);
    session.defaultSession.once('will-download', (_event, item) => {
      const filename = path.join(directory, 'history.csv'); item.setSavePath(filename);
      item.once('done', (_event, status) => { clearTimeout(timeout); status === 'completed' ? resolve(filename) : reject(new Error(`CSV ${status}`)); });
    });
  });
  await click('#export');
  const csv = readFileSync(await download, 'utf8');
  assert(csv.includes('timestamp_utc,five_hour_remaining_percent,seven_day_remaining_percent') && csv.includes(',30,10'), 'CSV must contain actual fixture readings');
  await click('#lock');
  assert.equal(await evaluate(`document.querySelector('#dashboard').hidden && document.querySelector('#five-value').textContent==='—' && document.querySelectorAll('.dot').length===0 && localStorage.length===0 && sessionStorage.length===0`), true);
  const requestText = JSON.stringify(requests);
  assert(!requestText.includes(master) && !requestText.includes(view.toString('hex')) && !requestText.includes('state.enc') && !requestText.includes('view:'), 'Secrets must never appear in requests');
  assert.equal(errors.length, 0, `Renderer/CSP errors: ${errors.join('; ')}`);
  console.log('Web smoke: passed (locked, demo, history, read-only decryption, archive, mobile, CSV, privacy)');
}
void main().then(() => { window?.destroy(); server?.close(); app.exit(0); }).catch(error => { console.error(error.stack); window?.destroy(); server?.close(); app.exit(1); });

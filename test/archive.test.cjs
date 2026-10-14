'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { HistoryStore, accountKey, DAY } = require('../src/history.cjs');
const { utcDay, validateRange } = require('../src/history-data.cjs');
const { sampleHistory } = require('../src/ui/history-chart.js');
const { historyCsv } = require('../src/history-csv.cjs');
const { derive, seal, open } = require('../src/cloud-crypto.cjs');
const { CloudSync } = require('../src/cloud-sync.cjs');
const { saveArchive, validArchivePath } = require('../scripts/cloud-archive.cjs');
const account = accountKey({ type: 'chatgpt', email: 'archive@example.invalid' });
const other = accountKey({ type: 'chatgpt', email: 'other@example.invalid' });
const base = Date.UTC(2025, 0, 10, 12), now = base + 500 * DAY + 15000;
const point = (at, fiveHour = 60, weekly = 40) => ({ at, fiveHour, weekly, gapMs: 130000 });
const state = (at, value = 60) => ({ status: 'ready', updatedAt: at, usage: { fiveHour: { remainingPercent: value }, weekly: { remainingPercent: 40 } } });
function directory(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-archive-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
test('daily storage retains readings older than a year across restart and keeps accounts isolated', t => {
  const dir = directory(t); let clock = base;
  const h = new HistoryStore(dir, () => clock); h.selectAccount(account); h.capture(state(clock), 60);
  clock = now; h.capture(state(clock, 20), 60);
  const restored = new HistoryStore(dir, () => clock);
  const range = { start: base - DAY, end: base + DAY };
  assert.deepEqual(restored.snapshot(range).points, []);
  restored.selectAccount(account); assert.equal(restored.snapshot().points.length, 1);
  assert.equal(restored.snapshot(range).points[0].fiveHour, 60);
  restored.selectAccount(other); restored.capture(state(clock, 95), 60);
  assert.equal(restored.snapshot(range).points.length, 0);
  restored.selectAccount(account); assert.equal(restored.snapshot(range).points[0].fiveHour, 60);
  assert.equal(restored.snapshot().points[0].fiveHour, 20);
  assert.ok(fs.existsSync(path.join(dir, 'history', account, `${utcDay(base)}.json`)));
});
test('legacy rolling files migrate only after verified login and remain readable by the old app', t => {
  const dir = directory(t), file = path.join(dir, 'usage-history.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, account, points: [point(base)] }));
  const h = new HistoryStore(dir, () => base); assert.ok(!fs.existsSync(path.join(dir, 'history')));
  h.selectAccount(account); assert.equal(h.snapshot().points.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).schema, 1);
  const later = new HistoryStore(dir, () => now); later.selectAccount(account);
  assert.equal(later.snapshot({ start: base - DAY, end: base + DAY }).points.length, 1);
});
test('remote historical merges preserve local bucket values, reject future points and survive restart', t => {
  const dir = directory(t), h = new HistoryStore(dir, () => now); h.selectAccount(account);
  h.capture(state(now, 20), 60);
  h.merge({ account, points: [point(base), point(now + 1), point(now - 1000, 90), point(now, 95)] });
  assert.equal(h.snapshot().points.at(-1).fiveHour, 20);
  const restored = new HistoryStore(dir, () => now); restored.selectAccount(account);
  assert.equal(restored.snapshot({ start: base - DAY, end: base + DAY }).points.length, 1);
  assert.equal(restored.snapshot().points.length, 1);
});
test('corrupt daily files are preserved as backups without deleting other days', t => {
  const dir = directory(t), h = new HistoryStore(dir, () => now); h.selectAccount(account);
  h.merge({ account, points: [point(base), point(base + DAY)] });
  const archive = path.join(dir, 'history', account); fs.writeFileSync(path.join(archive, `${utcDay(base)}.json`), 'broken');
  const restored = new HistoryStore(dir, () => now); restored.selectAccount(account);
  const model = restored.snapshot({ start: base - DAY, end: base + 2 * DAY });
  assert.equal(model.points.length, 1); assert.equal(model.saveError, true);
  assert.ok(fs.readdirSync(archive).some(name => name.includes('.backup-')));
});
test('historical views are bounded to 90 days while dates can be arbitrarily old', () => {
  assert.deepEqual(validateRange({ start: base, end: base + DAY }, now), { start: base, end: base + DAY });
  for (const range of [{ start: 0, end: now }, { start: now, end: now }, { start: base, end: base + 92 * DAY }, { start: now, end: now + 2 * DAY }]) assert.throws(() => validateRange(range, now));
});
test('long-range sampling bounds drawing size and preserves actual extremes and missing intervals', () => {
  const points = Array.from({ length: 50000 }, (_, i) => point(base + i * 60000, i % 100));
  points[1234].fiveHour = 0; points[1235].fiveHour = 100;
  for (let i = 20000; i < 25000; i++) points[i].fiveHour = null;
  const sampled = sampleHistory(points, 'fiveHour', base, points.at(-1).at, 320), flat = sampled.flat();
  assert.ok(flat.length <= 1280); assert.ok(flat.some(p => p.fiveHour === 0)); assert.ok(flat.some(p => p.fiveHour === 100));
  assert.ok(flat.every(p => points.includes(p)));
  assert.ok(sampled.every(segment => !(segment[0].at < points[20000].at && segment.at(-1).at > points[24999].at)));
});
test('CSV exports raw UTC readings, preserves zero and leaves unknown quotas blank', () => {
  const csv = historyCsv([point(base, 0, null), point(base + 60000, 37.5, 99)]);
  assert.ok(csv.startsWith('\ufefftimestamp_utc,')); assert.ok(csv.includes(`${new Date(base).toISOString()},0,\r\n`)); assert.ok(csv.includes(',37.5,99\r\n'));
});
test('encrypted cloud archives keep old days intact and reveal no account data or credentials', async t => {
  const dir = directory(t), key = derive('3'.repeat(64), 'history');
  const first = await saveArchive(dir, key, { account, points: [point(base)] });
  const oldFile = path.join(dir, 'archive', first.id, `${utcDay(base)}.enc.json`), oldBytes = fs.readFileSync(oldFile, 'utf8');
  const next = await saveArchive(dir, key, { account, points: [point(now)] }, first);
  assert.equal(next.id, first.id); assert.equal(fs.readFileSync(oldFile, 'utf8'), oldBytes);
  assert.equal(next.firstDay, utcDay(base)); assert.equal(next.lastDay, utcDay(now));
  assert.ok(!oldBytes.includes(account)); assert.equal(open(oldBytes, key, 'history-archive').points[0].at, base);
  assert.ok(validArchivePath(`archive/${first.id}/${utcDay(base)}.enc.json`)); assert.equal(validArchivePath('archive/../auth.json'), false);
  await assert.rejects(saveArchive(dir, key, { account: other, points: [point(base)] }, first));
});
test('selected historical cloud days decrypt and persist locally without importing another account', async t => {
  const dir = directory(t), h = new HistoryStore(dir, () => now); h.selectAccount(account);
  const key = derive('4'.repeat(64), 'history'), archive = { id: 'a'.repeat(32), firstDay: utcDay(base), lastDay: utcDay(base) };
  const sync = new CloudSync({ key }, h, { clock: () => now, fetcher: async () => new Response(seal({ schema: 1, account, day: utcDay(base), points: [point(base)] }, key, 'history-archive')) });
  sync.state = { status: 'ready', archive }; await sync.loadRange({ start: base - 3600000, end: base + 3600000 });
  assert.equal(sync.state.archiveStatus, 'ready'); assert.equal(h.snapshot({ start: base - DAY, end: base + DAY }).points.length, 1);
  sync.loadedDays.clear(); sync.fetcher = async () => new Response(seal({ schema: 1, account: other, day: utcDay(base), points: [point(base, 90)] }, key, 'history-archive'));
  await sync.loadRange({ start: base - 3600000, end: base + 3600000 }); assert.equal(sync.state.archiveStatus, 'error'); assert.equal(h.snapshot({ start: base - DAY, end: base + DAY }).points[0].fiveHour, 60);
});
test('missing cloud days are gaps, and changing accounts during download discards results', async () => {
  const key = derive('4'.repeat(64), 'history'), h = new HistoryStore(null, () => now); h.selectAccount(account);
  const archive = { id: 'a'.repeat(32), firstDay: utcDay(base), lastDay: utcDay(base) }, range = { start: base - 3600000, end: base + 3600000 };
  const sync = new CloudSync({ key }, h, { clock: () => now, fetcher: async () => new Response('', { status: 404 }) }); sync.state = { status: 'ready', archive };
  await sync.loadRange(range); assert.equal(sync.state.archiveStatus, 'ready'); assert.equal(h.snapshot(range).points.length, 0);
  sync.loadedDays.clear(); let finish; sync.fetcher = () => new Promise(resolve => { finish = resolve; });
  const pending = sync.loadRange(range); h.selectAccount(other); sync.reset(); finish(new Response(seal({ schema: 1, account, day: utcDay(base), points: [point(base)] }, key, 'history-archive'))); await pending;
  assert.equal(h.snapshot(range).points.length, 0);
});
test('worker publishes the daily archive pointer while keeping credentials out of the view', async t => {
  const { collect } = require('../scripts/cloud-record.cjs'), { EventEmitter } = require('node:events');
  const dir = directory(t), key = derive('5'.repeat(64), 'history'), calls = [];
  const client = new EventEmitter(); client.close = () => {};
  client.request = async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'archive@example.invalid' } } : { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 25 }, secondary: { windowDurationMins: 10080, usedPercent: 40 } } };
  const success = await collect({ client, clock: () => now, readAuth: async () => ({ tokens: 'only-test-token' }), archive: snapshot => saveArchive(dir, key, snapshot), publish: async (view, state) => calls.push({ view, state }) });
  assert.equal(success, true); assert.ok(calls[0].view.archive.id); assert.equal(calls[0].view.points[0].fiveHour, 75); assert.ok(!JSON.stringify(calls[0].view).includes('only-test-token'));
});
test('archive-write errors retain refreshed credentials and measured values for a later retry', async () => {
  const { collect } = require('../scripts/cloud-record.cjs'), { EventEmitter } = require('node:events'), calls = [];
  const client = new EventEmitter(); client.close = () => {};
  client.request = async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'archive@example.invalid' } } : { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 25 } } };
  const success = await collect({ client, clock: () => now, readAuth: async () => ({ tokens: 'rotated-test-token' }), archive: async () => { throw new Error('disk failure'); }, publish: async (view, state) => calls.push({ view, state }) });
  assert.equal(success, false); assert.equal(calls[0].state.auth.tokens, 'rotated-test-token'); assert.equal(calls[0].state.points[0].fiveHour, 75); assert.equal(calls[0].view.status, 'error');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { HistoryStore, accountKey, DAY } = require('../src/history.cjs');
const { historySegments } = require('../src/ui/history-chart.js');
const first = accountKey({ type: 'chatgpt', email: 'first@example.invalid' });
const second = accountKey({ type: 'chatgpt', email: 'second@example.invalid' });
function sample(at, fiveHour = 60, weekly = 40, status = 'ready') {
  return { updatedAt: at, status, usage: { fiveHour: { remainingPercent: fiveHour }, weekly: { remainingPercent: weekly } } };
}
test('keeps a bounded 24-hour history across restart without exposing it before account verification', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 3 * DAY; const history = new HistoryStore(dir, () => now);
  history.selectAccount(first); history.capture(sample(now - DAY), 60); history.capture(sample(now), 60);
  const restored = new HistoryStore(dir, () => now);
  assert.equal(restored.snapshot().points.length, 0);
  restored.selectAccount(first); assert.equal(restored.snapshot().points.length, 2);
  now += 1000; assert.equal(restored.snapshot().points.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'usage-history.json'), 'utf8');
  assert.equal(raw.includes('example.invalid'), false); assert.equal(raw.includes('token'), false);
});
test('stale, unknown, future and out-of-order values cannot invent history', () => {
  const now = 3 * DAY; const history = new HistoryStore(null, () => now); history.selectAccount(first);
  assert.equal(history.capture(sample(now, 60, 40, 'stale'), 60), false);
  assert.equal(history.capture(sample(now + 1000), 60), false);
  assert.equal(history.capture(sample(now, 60, NaN), 60), true);
  assert.equal(history.capture(sample(now - 60000), 60), false);
  assert.equal(history.snapshot().points.length, 1);
  assert.equal(history.snapshot().points[0].weekly, null);
});
test('frequent notifications coalesce and switching accounts never joins histories', () => {
  let now = 3 * DAY; const history = new HistoryStore(null, () => now); history.selectAccount(first);
  history.capture(sample(now), 60); now += 500; history.capture(sample(now, 59), 60);
  assert.equal(history.snapshot().points.length, 1); assert.equal(history.snapshot().points[0].fiveHour, 59);
  history.suspend(); assert.equal(history.snapshot().points.length, 0); assert.equal(history.capture(sample(now), 60), false);
  history.selectAccount(first); assert.equal(history.snapshot().points.length, 1);
  history.selectAccount(second); assert.equal(history.snapshot().points.length, 0);
});
test('breaks lines at missing values and polling gaps, while retaining measured recovery', () => {
  const points = [
    { at: 100000, fiveHour: 30, weekly: 50, gapMs: 130000 },
    { at: 160000, fiveHour: 100, weekly: null, gapMs: 130000 },
    { at: 220000, fiveHour: 99, weekly: 40, gapMs: 130000 },
    { at: 900000, fiveHour: 98, weekly: 39, gapMs: 130000 },
  ];
  assert.deepEqual(historySegments(points, 'fiveHour').map(s => s.length), [3, 1]);
  assert.deepEqual(historySegments(points, 'weekly').map(s => s.length), [1, 1, 1]);
  assert.equal(historySegments(points, 'fiveHour')[0][1].fiveHour, 100);
});
test('backs up damaged files and tolerates disk-write failures without losing live samples', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'usage-history.json'), 'damaged');
  const history = new HistoryStore(dir); history.selectAccount(first); history.capture(sample(Date.now()), 60);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('usage-history.json.backup-')));
  history.file = path.join(dir, 'missing', 'blocked'); fs.writeFileSync(path.join(dir, 'missing'), 'file');
  history.capture(sample(Date.now()), 60); assert.equal(history.snapshot().saveError, true); assert.equal(history.snapshot().points.length, 1);
});

test('accounts with no stable marker can use session-only samples without overwriting stored history', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = new HistoryStore(dir); history.selectAccount(first); history.capture(sample(Date.now()), 60);
  const file = path.join(dir, 'usage-history.json'); const before = fs.readFileSync(file, 'utf8');
  assert.equal(accountKey({ type: 'chatgpt', email: null }), null);
  history.selectAccount(second, false); history.capture(sample(Date.now()), 60);
  assert.equal(history.snapshot().sessionOnly, true); assert.equal(history.snapshot().points.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('continuous notifications retain earlier minutes instead of forever replacing one point', () => {
  let now = 3 * DAY; const history = new HistoryStore(null, () => now); history.selectAccount(first);
  for (let i = 0; i < 120; i++) { history.capture(sample(now), 60); now += 1000; }
  const points = history.snapshot().points;
  assert.ok(points.length >= 4 && points.length <= 5);
  assert.ok(points[0].at < now - 60000);
});

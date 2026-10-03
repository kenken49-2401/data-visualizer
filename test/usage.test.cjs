'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsage, publicError } = require('../src/usage.cjs');
const { bottomLeft } = require('../src/position.cjs');

const window = (minutes, usedPercent = 28) => ({ windowDurationMins: minutes, usedPercent, resetsAt: 2000000000 });
const response = (primary = window(300), secondary = window(10080)) => ({ rateLimits: { limitId: 'codex', primary, secondary, planType: 'plus' } });

test('uses account percentages and converts epoch seconds without estimating counts', () => {
  const usage = normalizeUsage(response());
  assert.equal(usage.fiveHour.remainingPercent, 72);
  assert.equal(usage.weekly.remainingPercent, 72);
  assert.equal(usage.fiveHour.resetsAt, 2000000000000);
});

test('selects the codex bucket and matches periods even when windows are reversed', () => {
  const r = response(window(10080, 90), window(300, 60));
  r.rateLimitsByLimitId = { codex: r.rateLimits };
  r.rateLimits = { limitId: 'another-model', primary: window(300, 0) };
  const usage = normalizeUsage(r);
  assert.equal(usage.fiveHour.remainingPercent, 40);
  assert.equal(usage.weekly.remainingPercent, 10);
});

test('does not infer a period from window order or fabricate an absent quota', () => {
  const usage = normalizeUsage(response({ usedPercent: 20 }, window(60)));
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.weekly, null);
});

test('rejects invalid percentages and leaves invalid reset times unknown', () => {
  for (const percentage of [NaN, Infinity, -1, '10', null]) {
    assert.equal(normalizeUsage(response(window(300, percentage))).fiveHour, null);
  }
  const r = response(window(300, 110));
  r.rateLimits.primary.resetsAt = 'tomorrow';
  assert.equal(normalizeUsage(r).fiveHour.remainingPercent, 0);
  assert.equal(normalizeUsage(r).fiveHour.resetsAt, null);
});

test('does not turn an elapsed reset into an invented full quota', () => {
  const r = response(window(300, 100));
  r.rateLimits.primary.resetsAt = 1;
  assert.equal(normalizeUsage(r).fiveHour.remainingPercent, 0);
});

test('does not present an unrelated model bucket as the Codex quota', () => {
  assert.throws(() => normalizeUsage({ rateLimits: { limitId: 'review', primary: window(300) } }), { code: 'NO_CODEX_QUOTA' });
  assert.throws(() => normalizeUsage(null), { code: 'NO_CODEX_QUOTA' });
});

test('does not disclose raw RPC errors in the user message', () => {
  const error = publicError(new Error('request to https://private.example/?token=secret failed'));
  assert.ok(!JSON.stringify(error).includes('secret'));
  assert.equal(publicError(new Error('chatgpt authentication required to read rate limits')).kind, 'auth');
});

test('places inside a negative-coordinate secondary display and a small host window', () => {
  assert.deepEqual(bottomLeft({ x: -1920, y: 0, width: 1920, height: 1080 }, { width: 354, height: 242 }),
    { x: -1906, y: 824, width: 354, height: 242 });
  const bounds = bottomLeft({ x: 200, y: 100, width: 250, height: 180 }, { width: 354, height: 242 });
  assert.ok(bounds.x >= 200 && bounds.y >= 100);
  assert.ok(bounds.x + bounds.width <= 450 && bounds.y + bounds.height <= 280);
});

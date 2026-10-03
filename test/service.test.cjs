'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UsageService } = require('../src/usage-service.cjs');

const snapshot = { rateLimits: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } } };
class FakeClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.closed = false; }
  request(method) { return new Promise((resolve, reject) => this.calls.push({ method, resolve, reject })); }
  close() { this.closed = true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('coalesces concurrent refreshes and labels retained data after a network failure', async t => {
  const client = new FakeClient();
  const service = new UsageService(client, { clock: () => 12345 });
  t.after(() => service.stop());
  service.start();
  const first = service.refresh(); const second = service.refresh();
  assert.equal(client.calls.length, 1);
  client.calls[0].resolve(snapshot);
  await Promise.all([first, second]);
  assert.equal(service.state.status, 'ready');
  const failed = service.refresh();
  client.calls[1].reject(new Error('offline'));
  await failed;
  assert.equal(service.state.status, 'stale');
  assert.equal(service.state.updatedAt, 12345);
  assert.equal(service.state.usage.fiveHour.remainingPercent, 50);
});

test('clears cached values after authentication loss', async t => {
  const client = new FakeClient(); const service = new UsageService(client);
  t.after(() => service.stop());
  service.start(); client.calls[0].resolve(snapshot); await tick();
  const next = service.refresh();
  client.calls[1].reject(new Error('chatgpt authentication required'));
  await next;
  assert.equal(service.state.status, 'error');
  assert.equal(service.state.usage, null);
});

test('ignores an in-flight response belonging to a previous account', async t => {
  const client = new FakeClient(); const service = new UsageService(client);
  t.after(() => service.stop());
  service.start();
  client.emit('notification', 'account/updated', {});
  client.calls[0].resolve(snapshot);
  await tick();
  assert.equal(service.state.usage, null);
  assert.equal(service.state.status, 'loading');
});

test('rereads a full snapshot after sparse notifications', async t => {
  const client = new FakeClient(); const service = new UsageService(client);
  t.after(() => service.stop());
  service.start(); client.calls[0].resolve(snapshot); await tick();
  client.emit('notification', 'account/rateLimits/updated', { rateLimits: { primary: null } });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].method, 'account/rateLimits/read');
  client.calls[1].resolve({ rateLimits: { limitId: 'codex', primary: null, secondary: snapshot.rateLimits.secondary } });
  await tick();
  assert.equal(service.state.usage.fiveHour, null);
  assert.equal(service.state.usage.weekly.remainingPercent, 90);
});

test('does not publish data after shutdown', async () => {
  const client = new FakeClient(); const service = new UsageService(client);
  service.start(); service.stop(); client.calls[0].resolve(snapshot); await tick();
  assert.equal(service.state.usage, null);
  assert.equal(client.closed, true);
});

test('changing the polling interval replaces the old timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeClient(); const service = new UsageService(client);
  t.after(() => service.stop());
  service.start(); client.calls[0].resolve(snapshot); await tick();
  service.setIntervalMs(180000);
  t.mock.timers.tick(60000); assert.equal(client.calls.length, 1);
  t.mock.timers.tick(120000); assert.equal(client.calls.length, 2);
  client.calls[1].resolve(snapshot); await tick();
});

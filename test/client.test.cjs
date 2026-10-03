'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexClient } = require('../src/codex-client.cjs');

function fakeServer({ reply = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', 0); };
  const requests = [];
  child.stdin.on('data', data => {
    const message = JSON.parse(data);
    requests.push(message);
    if (reply && message.method === 'initialize') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n'));
    }
  });
  return { child, requests };
}

test('initializes once, multiplexes out-of-order responses and parses split lines', async () => {
  const { child, requests } = fakeServer();
  const client = new CodexClient({ executable: () => 'fake', spawnProcess: () => child });
  await Promise.all([client.start(), client.start()]);
  assert.equal(requests.filter(m => m.method === 'initialize').length, 1);
  assert.equal(requests.filter(m => m.method === 'initialized').length, 1);
  const a = client.request('first'); const b = client.request('second');
  await new Promise(resolve => setImmediate(resolve));
  const [first, second] = requests.filter(m => m.method === 'first' || m.method === 'second');
  const line = JSON.stringify({ id: second.id, result: 'B' }) + '\n';
  child.stdout.write(line.slice(0, 5)); child.stdout.write(line.slice(5));
  child.stdout.write(JSON.stringify({ id: first.id, result: 'A' }) + '\n');
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  client.close();
});

test('times out missing initialization and terminates its own process', async () => {
  const { child } = fakeServer({ reply: false });
  let killed = false;
  child.kill = () => { killed = true; };
  const client = new CodexClient({ executable: () => 'fake', spawnProcess: () => child, timeoutMs: 10 });
  await assert.rejects(client.start(), { code: 'TIMEOUT' });
  assert.equal(killed, true);
  assert.equal(client.pending.size, 0);
});

test('rejects pending reads on exit and can reconnect', async () => {
  const first = fakeServer(); const second = fakeServer();
  let starts = 0;
  const client = new CodexClient({ executable: () => 'fake', spawnProcess: () => starts++ === 0 ? first.child : second.child });
  await client.start();
  const read = client.request('account/rateLimits/read');
  const rejected = assert.rejects(read, { code: 'DISCONNECTED' });
  await new Promise(resolve => setImmediate(resolve));
  first.child.emit('exit', 1);
  await rejected;
  await client.start();
  assert.equal(starts, 2);
  client.close();
});

test('forwards notifications without treating them as request responses', async () => {
  const { child } = fakeServer();
  const client = new CodexClient({ executable: () => 'fake', spawnProcess: () => child });
  await client.start();
  const event = new Promise(resolve => client.once('notification', (method, params) => resolve({ method, params })));
  child.stdout.write('{"method":"account/rateLimits/updated","params":{"rateLimits":{}}}\n');
  assert.deepEqual(await event, { method: 'account/rateLimits/updated', params: { rateLimits: {} } });
  client.close();
});

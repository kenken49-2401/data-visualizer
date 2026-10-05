'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { derive, seal, open, MAX_BYTES } = require('../src/cloud-crypto.cjs');
const { CloudConfig, CloudSync } = require('../src/cloud-sync.cjs');
const { HistoryStore, accountKey, DAY } = require('../src/history.cjs');
const { collect, validChallenge } = require('../scripts/cloud-record.cjs');
const master = '1'.repeat(64), key = derive(master, 'history'), now = 1800000000000;
const account = accountKey({ type: 'chatgpt', email: 'owner@example.invalid' });
const point = at => ({ at, fiveHour: 72, weekly: 41, gapMs: 1210000 });
const payload = extra => ({ schema: 1, status: 'ready', account, recordedAt: now, points: [point(now - 600000)], ...extra });
const history = () => { const h = new HistoryStore(null, () => now); h.selectAccount(account); return h; };
const response = data => new Response(seal(data, key, 'history'));
test('encryption separates public-view and credential keys and detects tampering', () => {
  const vault = derive(master, 'state'), view = seal(payload(), key, 'history');
  assert.deepEqual(open(view, key, 'history'), payload());
  assert.throws(() => open(view, vault, 'history'));
  assert.throws(() => open(seal({ auth: 'private' }, vault, 'state'), key, 'state'));
  assert.throws(() => open(view, key, 'state'));
  const modified = JSON.parse(view); modified.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => open(JSON.stringify(modified), key, 'history'));
  assert.throws(() => derive('not-a-key', 'history'));
});
test('OS configuration retains only the derived key, restores it and refuses plaintext storage', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-config-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const enc = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from('protected:' + v), decryptString: v => v.toString().slice(10) };
  const c = new CloudConfig(dir, enc), generated = c.generate();
  assert.ok(c.key.equals(derive(generated, 'history'))); assert.ok(!fs.readFileSync(c.file, 'utf8').includes(generated));
  assert.ok(new CloudConfig(dir, enc).key.equals(c.key)); c.disable(); assert.ok(!fs.existsSync(c.file));
  assert.throws(() => new CloudConfig(dir, { ...enc, getSelectedStorageBackend: () => 'basic_text' }).generate());
});
test('remote samples fill sleep gaps while preserving local records and rejecting future samples', async () => {
  const h = history(); h.capture({ status: 'ready', updatedAt: now, usage: { fiveHour: { remainingPercent: 69 } } }, 60);
  const s = new CloudSync({ key }, h, { clock: () => now, fetcher: async () => response(payload({ points: [point(now - DAY - 1), point(now - 600000), point(now + 1)] })) });
  await s.check(); assert.equal(s.state.status, 'ready'); assert.equal(h.points.length, 2); assert.equal(h.points.at(-1).fiveHour, 69);
});
test('unverified sessions, account mismatches and account changes during downloads never join histories', async () => {
  const h = history(), s = new CloudSync({ key }, h, { clock: () => now, fetcher: async () => response(payload({ account: 'b'.repeat(64) })) });
  await s.check(); assert.equal(s.state.status, 'account-mismatch'); assert.equal(h.points.length, 0);
  h.suspend(); await s.check(); assert.equal(h.points.length, 0); h.selectAccount(account, false); assert.equal(h.merge(payload()), false);
  h.selectAccount(account); let finish; s.fetcher = () => new Promise(r => { finish = r; });
  const pending = s.check(); h.selectAccount('b'.repeat(64)); s.reset(); finish(response(payload())); await pending;
  assert.equal(h.points.length, 0); assert.equal(s.state.status, 'waiting');
});
test('invalid keys, corrupt data, future timestamps and oversized responses keep local history', async () => {
  const h = history(); h.merge(payload());
  for (const fetcher of [async () => new Response('bad'), async () => new Response(seal(payload(), derive('2'.repeat(64), 'history'), 'history')), async () => response(payload({ recordedAt: now + 1 })), async () => new Response('x'.repeat(MAX_BYTES + 1))]) {
    const s = new CloudSync({ key }, h, { clock: () => now, fetcher }); await s.check(); assert.equal(s.state.status, 'unavailable'); assert.equal(h.points.length, 1);
  }
});
test('device challenges expire and only official authentication destinations are accepted', async () => {
  const challenge = { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', until: now + 600000 };
  const s = new CloudSync({ key }, history(), { clock: () => now, fetcher: async () => response(payload({ status: 'login', account: null, points: [], challenge })) });
  await s.check(); assert.deepEqual(s.state.challenge, challenge);
  s.fetcher = async () => response(payload({ status: 'login', challenge: { ...challenge, until: now - 1 } })); await s.check(); assert.equal(s.state.status, 'login-expired');
  assert.ok(validChallenge({ type: 'chatgptDeviceCode', ...challenge }));
  assert.equal(validChallenge({ type: 'chatgptDeviceCode', ...challenge, verificationUrl: 'https://auth.openai.com.attacker.invalid/' }), false);
});
class FakeClient extends EventEmitter {
  constructor(fail = false) { super(); this.fail = fail; }
  async request(method) {
    if (method === 'account/login/start') { setTimeout(() => this.emit('notification', 'account/login/completed', { loginId: 'test', success: true }), 5); return { type: 'chatgptDeviceCode', loginId: 'test', userCode: 'TEST', verificationUrl: 'https://auth.openai.com/codex/device' }; }
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'owner@example.invalid' } };
    if (this.fail) throw new Error('private backend response');
    return { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 28 }, secondary: { windowDurationMins: 10080, usedPercent: 59 } } };
  }
  close() { this.closed = true; }
}
test('headless login publishes a challenge and then records actual quotas with credentials only in the vault', async () => {
  const client = new FakeClient(), calls = [];
  assert.equal(await collect({ client, login: true, clock: () => now, readAuth: async () => ({ tokens: 'cloud-only-test' }), publish: async (view, state) => calls.push({ view, state }) }), true);
  assert.equal(calls[0].view.status, 'login'); assert.equal(calls[0].state, null);
  assert.equal(calls.at(-1).view.points[0].fiveHour, 72); assert.equal(calls.at(-1).state.auth.tokens, 'cloud-only-test');
  assert.ok(!JSON.stringify(calls.at(-1).view).includes('cloud-only-test')); assert.ok(client.closed);
});
test('quota failures preserve rotated credentials without fabricating samples or leaking errors', async () => {
  const calls = [], client = new FakeClient(true);
  assert.equal(await collect({ client, previous: payload(), clock: () => now, readAuth: async () => ({ tokens: 'rotated-test' }), publish: async (view, state) => calls.push({ view, state }) }), false);
  assert.equal(calls[0].view.status, 'error'); assert.equal(calls[0].view.points.length, 1); assert.equal(calls[0].state.auth.tokens, 'rotated-test'); assert.ok(!JSON.stringify(calls[0].view).includes('private backend')); assert.ok(client.closed);
});
test('unfinished device authorization times out, clears the code and closes its process', async () => {
  const client = new FakeClient(); client.request = async () => ({ type: 'chatgptDeviceCode', loginId: 'pending', userCode: 'TEST', verificationUrl: 'https://auth.openai.com/codex/device' });
  const calls = []; assert.equal(await collect({ client, login: true, timeoutMs: 10, clock: () => now, readAuth: async () => { throw new Error('absent'); }, publish: async v => calls.push(v) }), false);
  assert.equal(calls.at(-1).challenge, null); assert.ok(client.closed);
});

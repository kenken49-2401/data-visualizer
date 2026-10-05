'use strict';
// This entry point runs only on a fresh GitHub-hosted runner. It never reads the
// desktop's credentials, runs a model, or logs backend responses.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { CodexClient } = require('../src/codex-client.cjs');
const { HistoryStore, accountKey } = require('../src/history.cjs');
const { normalizeUsage } = require('../src/usage.cjs');
const { derive, seal, open } = require('../src/cloud-crypto.cjs');
const REPOSITORY = 'kenken49-2401/data-visualizer';
function validChallenge(value) {
  try { const url = new URL(value?.verificationUrl); return value.type === 'chatgptDeviceCode' && url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && (!url.port || url.port === '443') && typeof value.userCode === 'string' && value.userCode.length > 0 && value.userCode.length <= 100; } catch { return false; }
}
async function collect({ client, previous, login = false, publish, readAuth, clock = Date.now, timeoutMs = 600000 }) {
  const history = new HistoryStore(null, clock);
  if (previous?.account && /^[a-f0-9]{64}$/.test(previous.account)) { history.selectAccount(previous.account); history.merge(previous); }
  let listener, timer;
  try {
    if (login) {
      let loginId;
      const completed = [];
      const waiting = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Login timed out')), timeoutMs);
        listener = (method, params) => {
          if (method !== 'account/login/completed') return;
          if (!loginId) { completed.push(params); return; }
          if (params?.loginId === loginId) params.success ? resolve() : reject(new Error('Login failed'));
        };
        client.on('notification', listener);
      });
      // Attach a rejection handler while publishing the challenge to avoid an
      // unhandled timeout/disconnect if GitHub is slow or unavailable.
      waiting.catch(() => {});
      const result = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
      if (!validChallenge(result)) throw new Error('Invalid login challenge');
      loginId = result.loginId;
      await publish({ schema: 1, status: 'login', account: null, points: [], challenge: { verificationUrl: result.verificationUrl, userCode: result.userCode, until: clock() + timeoutMs } }, null);
      for (const params of completed) listener('account/login/completed', params);
      await waiting;
    }
    const result = await client.request('account/read', { refreshToken: true });
    const key = accountKey(result?.account);
    if (!key) throw new Error('ChatGPT login required');
    history.selectAccount(key);
    const usage = normalizeUsage(await client.request('account/rateLimits/read'));
    if (!usage.fiveHour && !usage.weekly) throw new Error('Quota unavailable');
    history.capture({ status: 'ready', usage, updatedAt: clock() }, 600);
    const auth = await readAuth();
    const snapshot = { schema: 1, account: key, points: history.snapshot().points };
    await publish({ ...snapshot, status: 'ready', recordedAt: clock(), challenge: null }, { ...snapshot, auth });
    return true;
  } catch {
    let refreshed = null;
    try { const auth = await readAuth(); if (history.key) refreshed = { schema: 1, account: history.key, points: history.snapshot().points, auth }; } catch {}
    await publish({ schema: 1, status: 'error', account: history.key, points: history.snapshot().points, challenge: null }, refreshed);
    return false;
  } finally { clearTimeout(timer); if (listener) client.removeListener('notification', listener); client.close(); }
}
async function run() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('GitHub-hosted recording only');
  const master = process.env.USAGE_RECORDING_KEY;
  if (!master) { console.log('Cloud recording is not configured.'); return; }
  const vaultKey = derive(master, 'state'), viewKey = derive(master, 'history');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-recording-'));
  const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}` };
  function git(args) {
    try { return execFileSync('git', args, { cwd: directory, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
    catch { throw new Error('Encrypted recording could not be saved'); }
  }
  const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  let previous = null;
  try {
    git(['init', '--quiet']); git(['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`]);
    // A network/auth failure must not be mistaken for an absent branch.
    const refs = git(['ls-remote', '--heads', 'origin', 'refs/heads/usage-records']);
    if (refs.trim()) { git(['fetch', '--quiet', '--depth=1', 'origin', 'usage-records']); git(['checkout', '--quiet', '-b', 'usage-records', 'FETCH_HEAD']); }
    else git(['checkout', '--quiet', '--orphan', 'usage-records']);
    if (git(['ls-files']).split('\n').filter(Boolean).some(name => !['state.enc.json', 'history.enc.json'].includes(name))) throw new Error('Recording branch contains unrelated files');
    try { previous = open(await fs.readFile(path.join(directory, 'state.enc.json'), 'utf8'), vaultKey, 'state'); }
    catch (error) { if (error.code !== 'ENOENT' && process.env.RECORDING_MODE !== 'login') throw new Error('Recording key does not match saved state'); }
    await fs.mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 });
    if (previous?.auth && process.env.RECORDING_MODE !== 'login') await fs.writeFile(authFile, JSON.stringify(previous.auth), { mode: 0o600 });
    const publish = async (view, state) => {
      await fs.writeFile(path.join(directory, 'history.enc.json'), seal(view, viewKey, 'history'));
      if (state) await fs.writeFile(path.join(directory, 'state.enc.json'), seal(state, vaultKey, 'state'));
      git(['add', '--', 'history.enc.json', 'state.enc.json'].filter(a => a !== 'state.enc.json' || state || previous));
      if (!git(['status', '--porcelain']).trim()) return;
      git(['-c', 'user.name=Codex Usage Recorder', '-c', 'user.email=usage-recorder@users.noreply.github.com', 'commit', '--quiet', '-m', 'Update encrypted usage recording']);
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/usage-records']);
    };
    const client = new CodexClient({ cliArgs: ['-c', 'cli_auth_credentials_store="file"'] });
    const succeeded = await collect({ client, previous, login: process.env.RECORDING_MODE === 'login', publish,
      readAuth: async () => JSON.parse(await fs.readFile(authFile, 'utf8')) });
    if (!succeeded) throw new Error('Cloud login or quota collection did not complete');
    console.log('Encrypted usage recording saved.');
  } finally { await fs.rm(authFile, { force: true }); await fs.rm(directory, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(() => { console.error('Cloud recording failed. Check the app setup and run login again if needed.'); process.exitCode = 1; });
module.exports = { collect, validChallenge };

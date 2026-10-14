'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { derive, open, MAX_BYTES } = require('./cloud-crypto.cjs');
const { validDay, utcDay, daysInRange, MAX_DAY_POINTS, validateRange } = require('./history-data.cjs');
const RECORDING_URL = 'https://raw.githubusercontent.com/kenken49-2401/data-visualizer/usage-records/history.enc.json';
function validAuthUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'auth.openai.com' && !u.username && !u.password && (!u.port || u.port === '443'); } catch { return false; }
}
class CloudConfig {
  constructor(directory, encryption) {
    this.file = path.join(directory, 'cloud-recording.json'); this.encryption = encryption; this.key = null; this.error = false;
    try {
      if (!this.available() || fs.statSync(this.file).size > 4096) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const key = encryption.decryptString(Buffer.from(raw.key, 'base64'));
      if (raw.schema !== 1 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid key');
      this.key = Buffer.from(key, 'hex');
    } catch (e) { if (e.code !== 'ENOENT') this.error = true; }
  }
  available() { return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text'; }
  generate() {
    if (!this.available()) throw new Error('OS encryption unavailable');
    const master = randomBytes(32).toString('hex');
    this.install(master); return master;
  }
  install(master) {
    if (!this.available()) throw new Error('OS encryption unavailable');
    const key = derive(master, 'history');
    const encrypted = this.encryption.encryptString(key.toString('hex'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, key: encrypted.toString('base64') }), { mode: 0o600 });
    fs.renameSync(temp, this.file); this.key = key; this.error = false;
  }
  disable() { fs.rmSync(this.file, { force: true }); this.key = null; this.error = false; }
}
class CloudSync extends EventEmitter {
  constructor(config, history, { fetcher = fetch, clock = Date.now } = {}) {
    super(); this.config = config; this.history = history; this.fetcher = fetcher; this.clock = clock;
    this.state = { status: config.error ? 'config-error' : config.key ? 'waiting' : 'disabled', challenge: null, recordedAt: null };
    this.busy = null; this.timer = null; this.generation = 0; this.loadedDays = new Set(); this.rangeToken = null; this.rangePromise = null; this.rangeAbort = null;
  }
  update(state) { this.state = state; this.emit('state', state); }
  reset() { this.generation++; this.rangeAbort?.abort(); this.rangeToken = null; this.loadedDays.clear(); this.update({ status: this.config.key ? 'waiting' : 'disabled', challenge: null, recordedAt: null }); }
  start() { if (!this.timer) this.timer = setInterval(() => void this.check(), 60000); void this.check(); }
  stop() { clearInterval(this.timer); this.timer = null; this.generation++; this.rangeAbort?.abort(); }
  check() {
    if (this.busy) return this.busy;
    if (!this.config.key) return Promise.resolve();
    this.busy = this.read().finally(() => { this.busy = null; }); return this.busy;
  }
  async readJson(url, key, purpose, signal = AbortSignal.timeout(15000)) {
    const response = await this.fetcher(`${url}?t=${this.clock()}`, { cache: 'no-store', redirect: 'error', signal });
    if (!response.ok) throw Object.assign(new Error('Unavailable'), { status: response.status });
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Oversized');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) throw new Error('Oversized'); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return open(Buffer.concat(chunks).toString('utf8'), key, purpose);
  }
  loadRange(range) {
    const { start, end } = validateRange(range, this.clock()), archive = this.state.archive, key = this.config.key, account = this.history.key, generation = this.generation;
    if (!key || !account || !this.history.persistent || !archive) return Promise.resolve();
    const days = daysInRange(start, Math.min(end, this.clock())).filter(day => day >= archive.firstDay && day <= archive.lastDay);
    const token = `${account}/${archive.id}/${days[0]}/${days.at(-1)}`;
    if (token === this.rangeToken && this.rangePromise) return this.rangePromise;
    this.rangeAbort?.abort(); this.rangeAbort = new AbortController(); const abort = this.rangeAbort;
    this.rangeToken = token;
    const pending = days.filter(day => !this.loadedDays.has(`${archive.id}/${day}`));
    if (!pending.length) { this.update({ ...this.state, archiveStatus: 'ready' }); return Promise.resolve(); }
    this.update({ ...this.state, archiveStatus: 'loading' });
    const current = () => generation === this.generation && key === this.config.key && account === this.history.key && token === this.rangeToken && !abort.signal.aborted;
    this.rangePromise = (async () => {
      let failed = false;
      const worker = async () => {
        while (pending.length && current()) {
          const day = pending.shift();
          try {
            const url = RECORDING_URL.replace('history.enc.json', `archive/${archive.id}/${day}.enc.json`);
            const raw = await this.readJson(url, key, 'history-archive', AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]));
            if (!current()) return;
            if (raw.schema !== 1 || raw.account !== account || raw.day !== day || !Array.isArray(raw.points) || raw.points.length > MAX_DAY_POINTS || raw.points.some(p => !Number.isSafeInteger(p?.at) || utcDay(p.at) !== day)) throw new Error('Invalid archive');
            this.history.merge(raw); this.loadedDays.add(`${archive.id}/${day}`);
          } catch (error) { if (current()) { if (error.status === 404) this.loadedDays.add(`${archive.id}/${day}`); else failed = true; } }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (current()) this.update({ ...this.state, archiveStatus: failed ? 'error' : 'ready' });
    })().finally(() => { if (this.rangeAbort === abort) this.rangePromise = null; });
    return this.rangePromise;
  }
  async read() {
    const key = this.config.key, account = this.history.key, generation = this.generation;
    try {
      const data = await this.readJson(RECORDING_URL, key, 'history');
      if (generation !== this.generation || key !== this.config.key || account !== this.history.key) return;
      if (data.schema !== 1 || !['ready', 'login', 'error'].includes(data.status) || !Array.isArray(data.points) || data.points.length > 3000 || data.account !== null && !/^[a-f0-9]{64}$/.test(data.account ?? '') || data.status === 'ready' && (!data.account || !Number.isSafeInteger(data.recordedAt) || data.recordedAt > this.clock())) throw new Error('Invalid recording');
      let challenge = null;
      if (data.status === 'login' && validAuthUrl(data.challenge?.verificationUrl) && typeof data.challenge?.userCode === 'string' && data.challenge.userCode.length <= 100 && Number.isSafeInteger(data.challenge.until) && data.challenge.until > this.clock() && data.challenge.until <= this.clock() + 15 * 60000) challenge = data.challenge;
      const mismatch = account && data.account && account !== data.account;
      if (!mismatch) this.history.merge(data);
      this.update({ status: mismatch ? 'account-mismatch' : data.status === 'login' ? challenge ? 'login' : 'login-expired' : data.status === 'error' ? 'recording-error' : !account ? 'account-pending' : this.clock() - data.recordedAt > 30 * 60000 ? 'delayed' : 'ready', challenge, archive: !mismatch && validRemoteArchive(data.archive, this.clock()) ? data.archive : null, archiveStatus: this.state.archiveStatus, recordedAt: Number.isSafeInteger(data.recordedAt) && data.recordedAt <= this.clock() ? data.recordedAt : null });
    } catch {
      if (generation === this.generation && key === this.config.key && account === this.history.key) this.update({ ...this.state, status: 'unavailable', challenge: null });
    }
  }
}
function validRemoteArchive(raw, now) { return !!raw && /^[a-f0-9]{32}$/.test(raw.id ?? '') && validDay(raw.firstDay) && validDay(raw.lastDay) && raw.firstDay <= raw.lastDay && raw.lastDay <= utcDay(now); }
module.exports = { CloudConfig, CloudSync, validAuthUrl, RECORDING_URL, validRemoteArchive };

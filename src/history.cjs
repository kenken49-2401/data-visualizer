'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DAY = 24 * 60 * 60 * 1000;
function accountKey(account) {
  // Store a hashed account marker rather than the email or token.
  if (account?.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email.trim()) return null;
  return createHash('sha256').update(`codex-history:${account.email.trim().toLowerCase()}`).digest('hex');
}
function percent(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function normalizePoint(raw) {
  if (!raw || !Number.isSafeInteger(raw.at) || raw.at <= 0) return null;
  const point = { at: raw.at, fiveHour: percent(raw.fiveHour), weekly: percent(raw.weekly),
    gapMs: Number.isFinite(raw.gapMs) ? Math.min(1810000, Math.max(130000, raw.gapMs)) : 130000 };
  return point.fiveHour === null && point.weekly === null ? null : point;
}
class HistoryStore {
  constructor(directory, clock = Date.now) {
    this.file = directory ? path.join(directory, 'usage-history.json') : null;
    this.persistent = true; this.clock = clock; this.key = null; this.storedKey = null; this.points = []; this.error = false;
    if (!this.file) return;
    try {
      if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw new Error('oversized');
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.schema !== 1 || !/^[a-f0-9]{64}$/.test(raw.account) || !Array.isArray(raw.points)) throw new Error('invalid');
      this.storedKey = raw.account;
      this.points = raw.points.map(normalizePoint).filter(Boolean).sort((a, b) => a.at - b.at);
      this.prune();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.points = []; this.storedKey = null;
        try { fs.renameSync(this.file, `${this.file}.backup-${Date.now()}`); } catch { this.error = true; }
      }
    }
  }
  suspend() { this.key = null; }
  selectAccount(key, persistent = true) {
    if (!/^[a-f0-9]{64}$/.test(key ?? '')) return false;
    if (this.storedKey !== key) this.points = [];
    this.key = this.storedKey = key; this.persistent = persistent; this.prune(); this.save(); return true;
  }
  prune() {
    const now = this.clock();
    this.points = this.points.filter(p => p.at >= now - DAY && p.at <= now).slice(-3000);
  }
  capture(state, intervalSeconds) {
    if (!this.key || state.status !== 'ready') return false;
    const point = normalizePoint({ at: state.updatedAt, fiveHour: state.usage?.fiveHour?.remainingPercent,
      weekly: state.usage?.weekly?.remainingPercent, gapMs: intervalSeconds * 2000 + 10000 });
    if (!point || point.at > this.clock() || point.at < this.clock() - DAY) return false;
    const last = this.points.at(-1);
    // Coalesce notifications in fixed 30-second buckets to retain the full day.
    if (last && point.at >= last.at && Math.floor(point.at / 30000) === Math.floor(last.at / 30000)) this.points[this.points.length - 1] = point;
    else if (!last || point.at > last.at) this.points.push(point);
    else return false;
    this.prune(); this.save(); return true;
  }
  merge(raw) {
    if (!this.key || !this.persistent || raw?.account !== this.key || !Array.isArray(raw.points) || raw.points.length > 3000) return false;
    const now = this.clock(), buckets = new Map();
    for (const point of [...raw.points.map(normalizePoint).filter(Boolean), ...this.points]) {
      if (point.at < now - DAY || point.at > now) continue;
      const bucket = Math.floor(point.at / 30000), previous = buckets.get(bucket);
      if (!previous || previous.at <= point.at) buckets.set(bucket, point);
    }
    this.points = [...buckets.values()].sort((a, b) => a.at - b.at);
    this.prune(); this.save(); return true;
  }
  save() {
    if (!this.file || !this.key || !this.persistent) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ schema: 1, account: this.key, points: this.points }), { mode: 0o600 });
      fs.renameSync(temp, this.file); this.error = false;
    } catch { this.error = true; try { fs.unlinkSync(temp); } catch {} }
  }
  snapshot() {
    this.prune(); const now = this.clock();
    return { start: now - DAY, end: now, points: this.key ? this.points : [], accountPending: !this.key, sessionOnly: !this.persistent, saveError: this.error };
  }
}
module.exports = { HistoryStore, accountKey, normalizePoint, DAY };

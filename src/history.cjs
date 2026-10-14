'use strict';
const fs = require('node:fs'), path = require('node:path');
const { HistoryArchive } = require('./history-archive.cjs');
const { DAY, MAX_DAY_POINTS, accountKey, normalizePoint, combine, validateRange } = require('./history-data.cjs');
class HistoryStore {
  constructor(directory, clock = Date.now) {
    this.directory = directory; this.file = directory ? path.join(directory, 'usage-history.json') : null;
    this.persistent = true; this.clock = clock; this.key = null; this.storedKey = null; this.points = []; this.error = false; this.archive = null; this.memory = [];
    this.legacy = null;
    if (!this.file) return;
    try {
      if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw new Error('oversized');
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.schema !== 1 || !/^[a-f0-9]{64}$/.test(raw.account) || !Array.isArray(raw.points)) throw new Error('invalid');
      this.legacy = { account: raw.account, points: combine(raw.points).filter(p => p.at <= this.clock()) }; this.storedKey = raw.account;
    } catch (error) {
      if (error.code !== 'ENOENT') { try { fs.renameSync(this.file, `${this.file}.backup-${Date.now()}`); } catch { this.error = true; } }
    }
  }
  suspend() { this.key = null; }
  selectAccount(key, persistent = true) {
    if (!/^[a-f0-9]{64}$/.test(key ?? '')) return false;
    if (this.storedKey !== key) { this.points = []; this.memory = []; }
    this.key = this.storedKey = key; this.persistent = persistent;
    if (this.directory && persistent) {
      this.archive = new HistoryArchive(this.directory, key);
      if (this.legacy?.account === key) { this.archive.merge(this.legacy.points, true); if (!this.archive.error) this.legacy = null; }
      this.points = this.archive.query(this.clock() - DAY, this.clock());
    } else { this.archive = null; }
    this.prune(); this.save(); return true;
  }
  prune() { const now = this.clock(); this.points = this.points.filter(p => p.at >= now - DAY && p.at <= now).slice(-MAX_DAY_POINTS); }
  capture(state, intervalSeconds) {
    if (!this.key || state.status !== 'ready') return false;
    const point = normalizePoint({ at: state.updatedAt, fiveHour: state.usage?.fiveHour?.remainingPercent, weekly: state.usage?.weekly?.remainingPercent, gapMs: intervalSeconds * 2000 + 10000 });
    if (!point || point.at > this.clock() || point.at < this.clock() - DAY || this.points.at(-1)?.at > point.at) return false;
    this.add([point]); this.save(); return true;
  }
  add(points, preferExisting = false) {
    if (this.archive) this.archive.merge(points, preferExisting); else this.memory = combine(preferExisting ? [...points, ...this.memory] : [...this.memory, ...points]);
    this.points = combine(preferExisting ? [...points, ...this.points] : [...this.points, ...points]); this.prune();
  }
  merge(raw) {
    if (!this.key || !this.persistent || raw?.account !== this.key || !Array.isArray(raw.points) || raw.points.length > MAX_DAY_POINTS) return false;
    const points = raw.points.map(normalizePoint).filter(p => p && p.at <= this.clock());
    this.add(points, true); this.save(); return true;
  }
  save() {
    // Retain the rolling file for rollback to older installers; daily files are never pruned.
    if (!this.file || !this.key || !this.persistent) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(temp, JSON.stringify({ schema: 1, account: this.key, points: this.points }), { mode: 0o600 }); fs.renameSync(temp, this.file); this.error = false; }
    catch { this.error = true; try { fs.unlinkSync(temp); } catch {} }
  }
  snapshot(range) {
    const { start, end } = validateRange(range, this.clock()); this.prune();
    const points = !this.key ? [] : combine([...(this.archive ? this.archive.query(start, end) : this.memory.filter(p => p.at >= start && p.at <= end)), ...this.points.filter(p => p.at >= start && p.at <= end)]).filter(p => p.at <= this.clock());
    return { start, end, points, earliestAt: this.key ? this.archive?.earliest() ?? this.memory[0]?.at ?? this.points[0]?.at ?? null : null, accountPending: !this.key, sessionOnly: !this.persistent, saveError: this.error || !!this.archive?.error, unlimited: true };
  }
}
module.exports = { HistoryStore, accountKey, normalizePoint, DAY };

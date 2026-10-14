'use strict';
const fs = require('node:fs'), path = require('node:path');
const { combine, utcDay, validDay, MAX_DAY_POINTS, daysInRange } = require('./history-data.cjs');
class HistoryArchive {
  constructor(directory, account) {
    this.directory = path.join(directory, 'history', account); this.account = account; this.cache = new Map(); this.days = new Set(); this.error = false;
    try { for (const file of fs.readdirSync(this.directory)) { const day = file.replace(/\.json$/, ''); if (file === `${day}.json` && validDay(day)) this.days.add(day); } } catch (e) { if (e.code !== 'ENOENT') this.error = true; }
  }
  read(day) {
    if (this.cache.has(day)) { const data = this.cache.get(day); this.cache.delete(day); this.cache.set(day, data); return data; }
    let points = [];
    const file = path.join(this.directory, `${day}.json`);
    try {
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid day file');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.schema !== 1 || data.account !== this.account || data.day !== day || !Array.isArray(data.points) || data.points.length > MAX_DAY_POINTS) throw new Error('Invalid day');
      points = combine(data.points).filter(p => utcDay(p.at) === day);
    } catch (e) {
      if (e.code !== 'ENOENT') { this.error = true; try { fs.renameSync(file, `${file}.backup-${Date.now()}`); } catch {} }
    }
    this.cache.set(day, points); if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
    return points;
  }
  merge(points, preferExisting = false) {
    const groups = new Map();
    for (const p of points) { const day = utcDay(p.at); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(p); }
    for (const [day, added] of groups) {
      const previous = this.read(day), data = combine(preferExisting ? [...added, ...previous] : [...previous, ...added]);
      if (JSON.stringify(data) === JSON.stringify(previous)) continue;
      this.cache.set(day, data); this.days.add(day);
      const file = path.join(this.directory, `${day}.json`), temp = `${file}.${process.pid}.tmp`;
      try { fs.mkdirSync(this.directory, { recursive: true }); fs.writeFileSync(temp, JSON.stringify({ schema: 1, account: this.account, day, points: data }), { mode: 0o600 }); fs.renameSync(temp, file); }
      catch { this.error = true; try { fs.unlinkSync(temp); } catch {} }
    }
  }
  query(start, end) {
    const points = [];
    for (const day of daysInRange(start, end)) if (this.days.has(day) || this.cache.has(day)) points.push(...this.read(day).filter(p => p.at >= start && p.at <= end));
    return points;
  }
  earliest() { const day = [...this.days].sort()[0]; return day ? this.read(day)[0]?.at ?? null : null; }
}
module.exports = { HistoryArchive };

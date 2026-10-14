'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { randomBytes } = require('node:crypto');
const { seal, open } = require('../src/cloud-crypto.cjs');
const { combine, utcDay, validDay, MAX_DAY_POINTS } = require('../src/history-data.cjs');
function validArchive(raw) { return !!raw && /^[a-f0-9]{32}$/.test(raw.id ?? '') && validDay(raw.firstDay) && validDay(raw.lastDay) && raw.firstDay <= raw.lastDay; }
function validArchivePath(file) { return /^archive\/[a-f0-9]{32}\/\d{4}-\d{2}-\d{2}\.enc\.json$/.test(file) && validDay(file.slice(-19,-9)); }
async function saveArchive(directory, key, snapshot, known) {
  if (!/^[a-f0-9]{64}$/.test(snapshot.account ?? '') || !Array.isArray(snapshot.points) || snapshot.points.length > MAX_DAY_POINTS) throw new Error('Invalid archive');
  const groups = new Map();
  for (const p of combine(snapshot.points)) { const day = utcDay(p.at); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(p); }
  if (!groups.size) return validArchive(known) ? known : null;
  const id = validArchive(known) ? known.id : randomBytes(16).toString('hex'), days = [...groups.keys()].sort();
  for (const [day, added] of groups) {
    const file = path.join(directory, 'archive', id, `${day}.enc.json`); let points = [];
    try {
      const raw = open(await fs.readFile(file, 'utf8'), key, 'history-archive');
      if (raw.schema !== 1 || raw.account !== snapshot.account || raw.day !== day || !Array.isArray(raw.points) || raw.points.length > MAX_DAY_POINTS || raw.points.some(p => utcDay(p.at) !== day)) throw new Error('Invalid day archive');
      points = raw.points;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const merged = combine([...points, ...added]);
    if (JSON.stringify(merged) === JSON.stringify(points)) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, seal({ schema: 1, account: snapshot.account, day, points: merged }, key, 'history-archive'));
  }
  return { id, firstDay: validArchive(known) && known.firstDay < days[0] ? known.firstDay : days[0], lastDay: validArchive(known) && known.lastDay > days.at(-1) ? known.lastDay : days.at(-1) };
}
module.exports = { saveArchive, validArchive, validArchivePath };

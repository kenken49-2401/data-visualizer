'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SIZES = { compact: { width: 292, height: 204 }, tiny: { width: 252, height: 178 }, comfortable: { width: 332, height: 224 } };
const DEFAULTS = { mode: 'screen', size: 'compact', x: null, y: null, offsetX: 0, offsetY: 0, intervalSeconds: 60, autoUpdates: true, alwaysOnTop: true };
function normalizeSettings(raw = {}) {
  const result = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  if (['screen', 'follow', 'manual'].includes(raw.mode)) result.mode = raw.mode;
  if (Object.hasOwn(SIZES, raw.size)) result.size = raw.size;
  for (const key of ['x', 'y', 'offsetX', 'offsetY']) {
    if (Number.isFinite(raw[key]) && Math.abs(raw[key]) <= 100000) result[key] = Math.round(raw[key]);
  }
  if ([60, 120, 180, 300].includes(raw.intervalSeconds)) result.intervalSeconds = raw.intervalSeconds;
  if (typeof raw.autoUpdates === 'boolean') result.autoUpdates = raw.autoUpdates;
  if (typeof raw.alwaysOnTop === 'boolean') result.alwaysOnTop = raw.alwaysOnTop;
  return result;
}
class SettingsStore {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    this.value = { ...DEFAULTS };
    this.error = false;
    try { this.value = normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        // Preserve a damaged configuration before creating a replacement.
        try { fs.renameSync(this.file, `${this.file}.backup-${Date.now()}`); } catch { this.error = true; }
      }
    }
  }
  update(patch) {
    this.value = normalizeSettings({ ...this.value, ...patch });
    if (this.error) return this.value;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch { this.error = true; try { fs.unlinkSync(temp); } catch {} }
    return this.value;
  }
}
module.exports = { SettingsStore, normalizeSettings, SIZES, DEFAULTS };

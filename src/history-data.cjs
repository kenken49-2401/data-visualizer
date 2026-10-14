'use strict';
const { createHash } = require('node:crypto');
const DAY = 86400000, MAX_DAY_POINTS = 3000, MAX_VIEW_DAYS = 90;
function accountKey(account) {
  if (account?.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email.trim()) return null;
  return createHash('sha256').update(`codex-history:${account.email.trim().toLowerCase()}`).digest('hex');
}
function percent(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null; }
function normalizePoint(raw) {
  if (!raw || !Number.isSafeInteger(raw.at) || raw.at <= 0 || raw.at > 8640000000000000) return null;
  const point = { at: raw.at, fiveHour: percent(raw.fiveHour), weekly: percent(raw.weekly), gapMs: Number.isFinite(raw.gapMs) ? Math.min(1810000, Math.max(130000, raw.gapMs)) : 130000 };
  return point.fiveHour === null && point.weekly === null ? null : point;
}
function utcDay(at) { return new Date(at).toISOString().slice(0, 10); }
function validDay(day) { return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && utcDay(Date.parse(day)) === day; }
function combine(points) {
  const buckets = new Map();
  for (const raw of points) { const p = normalizePoint(raw); if (!p) continue; const b = Math.floor(p.at / 30000), old = buckets.get(b); if (!old || old.at <= p.at) buckets.set(b, p); }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}
function validateRange(range, now = Date.now()) {
  if (range == null) return { start: now - DAY, end: now };
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start <= 0 || range.end <= range.start || range.end - range.start > MAX_VIEW_DAYS * DAY + 3600000 || range.end > now + DAY) throw new Error('Invalid history range');
  return { start: range.start, end: range.end };
}
function daysInRange(start, end) {
  const days = []; for (let at = Math.floor(start / DAY) * DAY; at <= end; at += DAY) days.push(utcDay(at)); return days;
}
module.exports = { DAY, MAX_DAY_POINTS, MAX_VIEW_DAYS, accountKey, normalizePoint, utcDay, validDay, combine, validateRange, daysInRange };

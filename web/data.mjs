// Public, read-only history client. Recording credentials and state.enc.json
// never enter the browser. Every fetched object is authenticated before use.
export const DAY = 86400000;
const MAX_BYTES = 2 * 1024 * 1024, MAX_DAY_POINTS = 3000;
const ROOT = 'https://raw.githubusercontent.com/kenken49-2401/data-visualizer/usage-records/';
const encoder = new TextEncoder();
const hexPattern = /^[a-f0-9]{64}$/;
// Old successful archives no longer change under the recorder's rolling
// 24-hour writes. Cache at most one 90-day view per unlocked key; locking drops
// the only strong reference to that CryptoKey and allows its cache to be freed.
const archivesByKey = new WeakMap(), MAX_CACHED_DAYS = 96;

function cachedArchive(key, identity) {
  const cache = archivesByKey.get(key), points = cache?.get(identity);
  if (points) { cache.delete(identity); cache.set(identity, points); }
  return points;
}
function cacheArchive(key, identity, points) {
  let cache = archivesByKey.get(key);
  if (!cache) { cache = new Map(); archivesByKey.set(key, cache); }
  cache.delete(identity); cache.set(identity, points);
  while (cache.size > MAX_CACHED_DAYS) cache.delete(cache.keys().next().value);
}

function keyHex(input) {
  if (typeof input !== 'string' || !hexPattern.test(input.trim().toLowerCase())) throw new Error('Invalid recording key');
  return input.trim().toLowerCase();
}
function fromHex(value) { return Uint8Array.from(value.match(/../g), part => Number.parseInt(part, 16)); }
function toHex(value) { return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function deriveViewKey(masterHex) {
  const master = await crypto.subtle.importKey('raw', fromHex(keyHex(masterHex)), 'HKDF', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('codex-usage-overlay-v1'), info: encoder.encode('history') }, master, 256));
}
export async function unlockKey(input) {
  if (typeof input !== 'string') throw new Error('Invalid recording key');
  const text = input.trim();
  const view = text.startsWith('view:') ? keyHex(text.slice(5)) : await deriveViewKey(text);
  return crypto.subtle.importKey('raw', fromHex(view), { name: 'AES-GCM' }, false, ['decrypt']);
}
function abortCheck(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
function decode64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encrypted recording');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function decrypt(text, key, purpose) {
  if (!['history', 'history-archive'].includes(purpose)) throw new Error('Invalid recording purpose');
  const raw = JSON.parse(text);
  if (raw?.schema !== 1) throw new Error('Invalid encrypted recording');
  const iv = decode64(raw.iv), tag = decode64(raw.tag), data = decode64(raw.data);
  if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('Invalid encrypted recording');
  const ciphertext = new Uint8Array(data.length + tag.length); ciphertext.set(data); ciphertext.set(tag, data.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128, additionalData: encoder.encode(`codex-usage:${purpose}:1`) }, key, ciphertext);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
}
async function readJson(file, key, purpose, { signal, fetcher = globalThis.fetch, clock = Date.now } = {}) {
  abortCheck(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Recording request timed out', 'TimeoutError')), 15000);
  let reader;
  try {
    const response = await fetcher(`${ROOT}${file}?t=${clock()}`, { cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error('Recording unavailable'), { status: response.status });
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Recording too large');
    if (!response.body?.getReader) throw new Error('Invalid recording response');
    reader = response.body.getReader();
    const chunks = []; let length = 0;
    while (true) {
      abortCheck(controller.signal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Recording too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result = await decrypt(new TextDecoder('utf-8', { fatal: true }).decode(bytes), key, purpose);
    abortCheck(controller.signal);
    return result;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
function percent(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
export function normalizePoint(raw) {
  if (!raw || !Number.isSafeInteger(raw.at) || raw.at <= 0 || raw.at > 8640000000000000) return null;
  const p = { at: raw.at, fiveHour: percent(raw.fiveHour), weekly: percent(raw.weekly), gapMs: Number.isFinite(raw.gapMs) ? Math.min(1810000, Math.max(130000, raw.gapMs)) : 130000 };
  return p.fiveHour === null && p.weekly === null ? null : p;
}
export function combine(points) {
  const buckets = new Map();
  for (const raw of points) {
    const p = normalizePoint(raw); if (!p) continue;
    const bucket = Math.floor(p.at / 30000), old = buckets.get(bucket);
    if (!old || old.at <= p.at) buckets.set(bucket, p);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}
function utcDay(at) { return new Date(at).toISOString().slice(0, 10); }
function validDay(day) { return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && utcDay(Date.parse(day)) === day; }
function validArchive(raw, now) {
  return raw && typeof raw.id === 'string' && /^[a-f0-9]{32}$/.test(raw.id) && validDay(raw.firstDay) && validDay(raw.lastDay) && raw.firstDay <= raw.lastDay && raw.lastDay <= utcDay(now);
}
function validatedPoints(raw, now, day) {
  if (!Array.isArray(raw) || raw.length > MAX_DAY_POINTS) throw new Error('Invalid recording points');
  return raw.map(item => {
    const point = normalizePoint(item);
    if (!point || point.at > now || day && utcDay(point.at) !== day) throw new Error('Invalid recording point');
    return point;
  });
}
function validateLatest(raw, now) {
  if (raw?.schema !== 1 || !['ready', 'login', 'error'].includes(raw.status) || raw.account !== null && (typeof raw.account !== 'string' || !hexPattern.test(raw.account))) throw new Error('Invalid recording');
  const points = validatedPoints(raw.points, now);
  if (!raw.account && points.length) throw new Error('Invalid recording account');
  const recordedAt = raw.recordedAt ?? null;
  if (recordedAt !== null && (!Number.isSafeInteger(recordedAt) || recordedAt <= 0 || recordedAt > now) || raw.status === 'ready' && (!raw.account || recordedAt === null)) throw new Error('Invalid recording time');
  if (raw.archive != null && !validArchive(raw.archive, now)) throw new Error('Invalid recording archive');
  const archive = raw.archive == null ? null : { id: raw.archive.id, firstDay: raw.archive.firstDay, lastDay: raw.archive.lastDay };
  // Deliberately project safe fields. Login codes, tokens and arbitrary remote
  // properties cannot be exposed by the online history page.
  return { schema: 1, status: raw.status, account: raw.account, points: combine(points), recordedAt, archive };
}
export async function loadLatest(key, options = {}) {
  return validateLatest(await readJson('history.enc.json', key, 'history', options), (options.clock ?? Date.now)());
}
export function validateRange(range, now = Date.now()) {
  if (range == null) return { start: now - DAY, end: now };
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start <= 0 || range.end <= range.start || range.end - range.start > 90 * DAY + 3600000 || range.end > now + DAY) throw new Error('Invalid history range');
  return { start: range.start, end: range.end };
}
export async function loadRange(key, latest, range, options = {}) {
  const { signal, onProgress } = options, now = (options.clock ?? Date.now)();
  abortCheck(signal);
  const view = validateLatest(latest, now), { start, end } = validateRange(range, now);
  const archive = view.archive, days = [], results = new Map(), missingDays = [];
  if (archive && view.account) {
    for (let at = Math.floor(start / DAY) * DAY; at <= Math.min(end, now); at += DAY) {
      const day = utcDay(at);
      if (day >= archive.firstDay && day <= archive.lastDay) days.push(day);
    }
  }
  const pending = [...days]; let loaded = 0, partial = false;
  onProgress?.({ loaded, total: days.length });
  async function worker() {
    while (pending.length) {
      abortCheck(signal);
      const day = pending.shift();
      try {
        const identity = `${view.account}/${archive.id}/${day}`;
        // Keep the entire day outside the latest 48 hours, so retries and late
        // uploads can still fill recent files on the next automatic refresh.
        const stable = Date.parse(day) + DAY <= now - 2 * DAY;
        const cached = stable ? cachedArchive(key, identity) : undefined;
        if (cached) results.set(day, cached);
        else {
          const raw = await readJson(`archive/${archive.id}/${day}.enc.json`, key, 'history-archive', options);
          abortCheck(signal);
          if (raw?.schema !== 1 || raw.account !== view.account || raw.day !== day) throw new Error('Invalid recording archive');
          const points = validatedPoints(raw.points, now, day);
          results.set(day, points);
          if (stable) cacheArchive(key, identity, points);
        }
      } catch (error) {
        abortCheck(signal);
        missingDays.push(day);
        // Days with no measurements have no file. Such gaps are expected and
        // must remain gaps, rather than being filled with invented readings.
        if (error.status !== 404) partial = true;
      }
      loaded++; onProgress?.({ loaded, total: days.length });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  abortCheck(signal);
  const points = combine([...days.flatMap(day => results.get(day) ?? []), ...view.points]).filter(p => p.at >= start && p.at <= Math.min(end, now));
  return { points, partial, missingDays: missingDays.sort() };
}
export function historyCsv(points) {
  const lines = ['timestamp_utc,five_hour_remaining_percent,seven_day_remaining_percent'];
  for (const p of combine(points)) lines.push([new Date(p.at).toISOString(), p.fiveHour ?? '', p.weekly ?? ''].join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
// This function is called only by the page's explicit demo mode. Synthetic
// values never enter recording storage or an unlocked real-data session.
export function makeDemo(range) {
  const { start, end } = validateRange(range), points = [], step = 600000;
  for (let at = start, i = 0; at <= end; at += step, i++) {
    if (i % 144 >= 61 && i % 144 <= 66) continue;
    points.push({ at, fiveHour: Math.round(100 - ((at - start) % (5 * 3600000)) / (5 * 3600000) * 83), weekly: Math.round(100 - ((at - start) % (7 * DAY)) / (7 * DAY) * 92), gapMs: 1210000 });
  }
  return points;
}

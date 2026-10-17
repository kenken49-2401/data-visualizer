'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { derive, seal, MAX_BYTES } = require('../src/cloud-crypto.cjs');
const web = import('../web/data.mjs');
const DAY = 86400000, now = Date.UTC(2026, 9, 17, 12);
const master = '7a'.repeat(32), view = derive(master, 'history'), account = 'a'.repeat(64), other = 'b'.repeat(64), archiveId = 'c'.repeat(32);
const point = (at, fiveHour = 65, weekly = 42) => ({ at, fiveHour, weekly, gapMs: 1210000 });
const latest = extra => ({ schema: 1, status: 'ready', account, recordedAt: now, points: [point(now)], ...extra });
const day = at => new Date(at).toISOString().slice(0, 10);
const encrypted = (value, purpose = 'history', key = view) => new Response(seal(value, key, purpose));
const opts = fetcher => ({ fetcher, clock: () => now });

test('browser HKDF and AES-GCM interoperate with the recorder using master or read-only keys', async () => {
  const { deriveViewKey, unlockKey, loadLatest } = await web;
  assert.equal(await deriveViewKey(master), view.toString('hex'));
  for (const input of [master, `view:${view.toString('hex')}`]) {
    const key = await unlockKey(input);
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', key), { name: 'InvalidAccessError' });
    const data = await loadLatest(key, opts(async (url, options) => {
      const u = new URL(url);
      assert.equal(u.origin, 'https://raw.githubusercontent.com');
      assert.equal(u.pathname, '/kenken49-2401/data-visualizer/usage-records/history.enc.json');
      assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
      return encrypted(latest({ challenge: { userCode: 'PRIVATE' }, auth: { accessToken: 'PRIVATE' } }));
    }));
    assert.deepEqual(data, { ...latest(), archive: null });
    assert.equal(JSON.stringify(data).includes('PRIVATE'), false);
  }
});

test('wrong keys, tampered ciphertext, malformed envelopes and the state purpose cannot be read', async () => {
  const { unlockKey, loadLatest } = await web, key = await unlockKey(master);
  const tampered = JSON.parse(seal(latest(), view, 'history'));
  tampered.data = Buffer.from('changed ciphertext').toString('base64');
  const invalid = [
    seal(latest(), derive('9'.repeat(64), 'history'), 'history'),
    seal(latest(), view, 'state'), JSON.stringify(tampered),
    JSON.stringify({ schema: 1, iv: 'bad=', tag: 'bad=', data: 'bad=' }),
    JSON.stringify({ schema: 1, iv: '!!!!', tag: '!!!!', data: '!!!!' }), 'not JSON'
  ];
  for (const text of invalid) await assert.rejects(loadLatest(key, opts(async () => new Response(text))));
  for (const input of ['', 'view:', 'view:1234', 'g'.repeat(64), `view:${'f'.repeat(63)}`]) await assert.rejects(unlockKey(input));
});

test('latest validation rejects future times, unknown accounts, oversized point arrays and archive traversal', async () => {
  const { unlockKey, loadLatest } = await web, key = await unlockKey(master);
  const invalid = [
    latest({ recordedAt: now + 1 }), latest({ points: [point(now + 1)] }),
    latest({ account: '../account' }), latest({ account: null }),
    latest({ points: Array.from({ length: 3001 }, () => point(now)) }),
    latest({ points: [point(now, null, null)] }),
    latest({ archive: { id: '../state', firstDay: '2026-10-15', lastDay: '2026-10-17' } }),
    latest({ archive: { id: archiveId, firstDay: '2026-02-30', lastDay: '2026-10-17' } }),
    latest({ archive: { id: archiveId, firstDay: '2026-10-15', lastDay: '2026-10-18' } })
  ];
  for (const raw of invalid) await assert.rejects(loadLatest(key, opts(async () => encrypted(raw))));
  const error = await loadLatest(key, opts(async () => encrypted({ schema: 1, status: 'error', account: null, points: [], auth: 'discarded' })));
  assert.deepEqual(error, { schema: 1, status: 'error', account: null, points: [], recordedAt: null, archive: null });
});

test('encrypted responses are bounded by headers and streamed bytes, including unknown content length', async () => {
  const { unlockKey, loadLatest } = await web, key = await unlockKey(master);
  let read = false;
  await assert.rejects(loadLatest(key, opts(async () => ({ ok: true, headers: new Headers({ 'content-length': `${MAX_BYTES + 1}` }), get body() { read = true; throw new Error('Must not read oversized body'); } }))), /too large/);
  assert.equal(read, false);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(loadLatest(key, opts(async () => new Response(stream))), /too large/);
  assert.equal(cancelled, true);
});

test('archive ranges fetch only existing date bounds, merge real readings and retain expected missing days', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master);
  const archive = { id: archiveId, firstDay: day(now - 2 * DAY), lastDay: day(now) };
  const old = point(now - 2 * DAY, 0, null), current = point(now, 20, 10);
  const calls = [], progress = [];
  const result = await loadRange(key, latest({ archive }), { start: now - 89 * DAY, end: now }, {
    ...opts(async url => {
      const name = new URL(url).pathname; calls.push(name);
      if (name.endsWith(`${day(now - DAY)}.enc.json`)) return new Response('', { status: 404 });
      const date = name.endsWith(`${day(now)}.enc.json`) ? day(now) : day(now - 2 * DAY);
      return encrypted({ schema: 1, account, day: date, points: date === day(now) ? [current] : [old] }, 'history-archive');
    }), onProgress: p => progress.push(p)
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(path => path.startsWith(`/kenken49-2401/data-visualizer/usage-records/archive/${archiveId}/`)));
  assert.deepEqual(result.points, [old, point(now)]);
  assert.equal(result.points[0].gapMs, 1210000);
  assert.deepEqual(result.missingDays, [day(now - DAY)]);
  assert.equal(result.partial, false);
  assert.deepEqual(progress[0], { loaded: 0, total: 3 });
  assert.deepEqual(progress.at(-1), { loaded: 3, total: 3 });
});

test('archive mismatches, wrong dates, future points and transport errors keep latest data and mark partial', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master);
  const archive = { id: archiveId, firstDay: day(now), lastDay: day(now) };
  const badArchives = [
    { schema: 1, account: other, day: day(now), points: [point(now)] },
    { schema: 1, account, day: day(now - DAY), points: [point(now)] },
    { schema: 1, account, day: day(now), points: [point(now - DAY)] },
    { schema: 1, account, day: day(now), points: [point(now + 1)] }
  ];
  const fetchers = badArchives.map(raw => async () => encrypted(raw, 'history-archive'));
  fetchers.push(async () => new Response('', { status: 503 }));
  fetchers.push(async () => encrypted({ schema: 1, account, day: day(now), points: [] }, 'history'));
  for (const fetcher of fetchers) {
    const result = await loadRange(key, latest({ archive }), { start: now - DAY, end: now }, opts(fetcher));
    assert.equal(result.partial, true); assert.deepEqual(result.points, [point(now)]); assert.deepEqual(result.missingDays, [day(now)]);
  }
});

test('range boundaries omit out-of-window samples without filling gaps', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master);
  const points = [point(now - 4000000), point(now - 3000000, null, 20), point(now - 100000), point(now)];
  const result = await loadRange(key, latest({ points }), { start: now - 3500000, end: now - 50000 }, opts(async () => { throw new Error('No archive fetch expected'); }));
  assert.deepEqual(result.points, points.slice(1, 3));
  assert.equal(result.partial, false);
});

test('range cancellation rejects and aborts requests rather than returning a partial cancelled view', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master), controller = new AbortController();
  const archive = { id: archiveId, firstDay: day(now - 5 * DAY), lastDay: day(now) };
  let calls = 0, aborted = 0;
  const running = loadRange(key, latest({ archive }), { start: now - 5 * DAY, end: now }, {
    ...opts(async (url, options) => {
      calls++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted++; reject(options.signal.reason); }, { once: true });
        queueMicrotask(() => controller.abort());
      });
    }), signal: controller.signal
  });
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(calls, 3); assert.equal(aborted, 3);
  await assert.rejects(loadRange(key, latest({ archive }), { start: now - DAY, end: now }, { signal: controller.signal }), { name: 'AbortError' });
});

test('range limits allow old dates, reject excessive windows before fetching, and CSV preserves raw zeros', async () => {
  const { unlockKey, validateRange, loadRange, historyCsv, makeDemo } = await web, key = await unlockKey(master);
  assert.deepEqual(validateRange({ start: now - 400 * DAY, end: now - 399 * DAY }, now), { start: now - 400 * DAY, end: now - 399 * DAY });
  for (const range of [{ start: 0, end: now }, { start: now, end: now }, { start: now - 92 * DAY, end: now }, { start: now, end: now + 2 * DAY }]) {
    await assert.rejects(loadRange(key, latest(), range, opts(async () => assert.fail('Invalid ranges must not fetch'))));
  }
  const csv = historyCsv([point(now - 60000, 0, null), point(now, 32.5, 90)]);
  assert.ok(csv.startsWith('\ufefftimestamp_utc,')); assert.ok(csv.includes(`${new Date(now - 60000).toISOString()},0,\r\n`)); assert.ok(csv.includes(',32.5,90\r\n'));
  const demo = makeDemo({ start: now - 400 * DAY, end: now - 399 * DAY });
  assert.ok(demo.length > 100); assert.ok(demo.every(p => p.at >= now - 400 * DAY && p.at <= now - 399 * DAY));
});

test('automatic refresh reuses only successful stable archives and retries recent, missing and failed days', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master);
  const archive = { id: archiveId, firstDay: day(now - 6 * DAY), lastDay: day(now) }, calls = new Map();
  const good = day(now - 6 * DAY), failed = day(now - 5 * DAY), missing = day(now - 4 * DAY);
  const fetcher = async url => {
    const date = new URL(url).pathname.slice(-19, -9), count = (calls.get(date) ?? 0) + 1; calls.set(date, count);
    if (date === missing) return new Response('', { status: 404 });
    if (date === failed && count === 1) return new Response('', { status: 503 });
    return encrypted({ schema: 1, account, day: date, points: [point(Date.parse(date) + 12 * 3600000)] }, 'history-archive');
  };
  const range = { start: now - 6 * DAY, end: now };
  const first = await loadRange(key, latest({ archive }), range, opts(fetcher));
  const second = await loadRange(key, latest({ archive }), range, opts(fetcher));
  assert.equal(first.partial, true); assert.equal(second.partial, false);
  assert.equal(calls.get(good), 1); assert.equal(calls.get(failed), 2); assert.equal(calls.get(missing), 2);
  assert.equal(calls.get(day(now - DAY)), 2); assert.equal(calls.get(day(now - 2 * DAY)), 2); assert.equal(calls.get(day(now)), 2);
  // A displayed result is a copy, and cannot mutate the private cached points.
  second.points[0].fiveHour = 1;
  const third = await loadRange(key, latest({ archive }), range, opts(fetcher));
  assert.equal(calls.get(good), 1); assert.equal(calls.get(failed), 2); assert.equal(third.points[0].fiveHour, 65);
});

test('stable archive caches isolate account, archive generation and unlocked key identities', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master), anotherKey = await unlockKey(master);
  const date = day(now - 10 * DAY), start = Date.parse(date) + 1000, end = start + 3600000;
  let calls = 0, currentAccount = account;
  const fetcher = async () => { calls++; return encrypted({ schema: 1, account: currentAccount, day: date, points: [point(start)] }, 'history-archive'); };
  const archive = id => ({ id, firstDay: date, lastDay: date });
  const load = (selectedKey, selectedAccount, id = archiveId) => loadRange(selectedKey, latest({ account: selectedAccount, archive: archive(id) }), { start, end }, opts(fetcher));
  await load(key, account); await load(key, account); assert.equal(calls, 1);
  currentAccount = other;
  const changed = await load(key, other); assert.equal(changed.partial, false); assert.equal(calls, 2);
  currentAccount = account;
  await load(key, account, 'd'.repeat(32)); assert.equal(calls, 3);
  await load(anotherKey, account); assert.equal(calls, 4);
});

test('old archive cache evicts earlier days after 96 days rather than growing with browsing history', async () => {
  const { unlockKey, loadRange } = await web, key = await unlockKey(master);
  const archive = { id: archiveId, firstDay: day(now - 500 * DAY), lastDay: day(now) };
  let calls = 0;
  const fetcher = async url => {
    calls++; const date = new URL(url).pathname.slice(-19, -9);
    return encrypted({ schema: 1, account, day: date, points: [point(Date.parse(date) + 12 * 3600000)] }, 'history-archive');
  };
  await loadRange(key, latest({ archive }), { start: now - 400 * DAY, end: now - 310 * DAY }, opts(fetcher));
  await loadRange(key, latest({ archive }), { start: now - 300 * DAY, end: now - 210 * DAY }, opts(fetcher));
  const before = calls;
  await loadRange(key, latest({ archive }), { start: now - 400 * DAY, end: now - 400 * DAY + 3600000 }, opts(fetcher));
  assert.equal(calls, before + 1);
});

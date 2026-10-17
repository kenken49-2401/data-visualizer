import { DAY, unlockKey, loadLatest, loadRange, historyCsv, makeDemo } from './data.mjs';

const $ = selector => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';
const fullTime = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTime = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
const state = { key: null, demo: false, latest: null, points: [], range: null, partial: false, missingDays: [], days: 1, request: 0, controller: null, loading: false, error: '', checkedAt: null };
const formatValue = value => Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : '—';
const warningClass = value => Number.isFinite(value) ? value <= 10 ? 'critical' : value <= 30 ? 'warning' : '' : '';
const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localToday = () => localDate(new Date());
$('#timezone').textContent = `(${Intl.DateTimeFormat().resolvedOptions().timeZone || '端末設定'})`;
$('#end-date').max = localToday();

function selection() {
  const date = $('#end-date').value;
  if (!date) { const end = Date.now(); return { start: end - state.days * DAY, end }; }
  const endDate = new Date(`${date}T00:00:00`); endDate.setDate(endDate.getDate() + 1);
  const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - state.days);
  return { start: startDate.getTime(), end: Math.min(endDate.getTime() - 1, Date.now()) };
}

function svgNode(tag, attrs = {}, text = '') {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  element.textContent = text; return element;
}

// Keep actual first/last/min/max readings per pixel bucket, and preserve gap
// boundaries when reducing long histories. No averaged or estimated quotas.
function sampledSegments(points, key, range) {
  let id = 0, previous;
  const buckets = new Map();
  for (const point of points) {
    if (!Number.isFinite(point[key])) { previous = null; id++; continue; }
    if (previous && point.at - previous.at > Math.max(previous.gapMs, point.gapMs)) id++;
    const column = Math.max(0, Math.min(319, Math.floor((point.at - range.start) / (range.end - range.start) * 320)));
    const item = { point, id }, bucket = buckets.get(column);
    if (!bucket) buckets.set(column, { first: item, last: item, min: item, max: item });
    else { bucket.last = item; if (point[key] < bucket.min.point[key]) bucket.min = item; if (point[key] > bucket.max.point[key]) bucket.max = item; }
    previous = point;
  }
  const selected = new Map();
  for (const bucket of buckets.values()) for (const item of Object.values(bucket)) selected.set(item.point.at, item);
  const result = []; let lastId, segment;
  for (const item of [...selected.values()].sort((a, b) => a.point.at - b.point.at)) {
    if (lastId !== item.id) { lastId = item.id; segment = []; result.push(segment); }
    segment.push(item.point);
  }
  return result;
}

function reading(point, key) {
  $('#reading').textContent = `${fullTime.format(new Date(point.at))} · ${key === 'fiveHour' ? '5時間枠' : '7日枠'} 残り ${formatValue(point[key])}`;
}

function plot(svg, key) {
  svg.replaceChildren();
  const range = state.range || selection(), points = state.points;
  const width = window.matchMedia('(max-width: 650px)').matches ? 650 : 1000;
  svg.setAttribute('viewBox', `0 0 ${width} 260`);
  const left = width === 650 ? 47 : 57, right = width - 30, top = 19, bottom = 210;
  const x = at => left + (at - range.start) / (range.end - range.start) * (right - left);
  const y = value => bottom - value / 100 * (bottom - top);
  svg.append(svgNode('title', {}, `${key === 'fiveHour' ? '5時間枠' : '7日枠'}の残り使用量`));
  svg.append(svgNode('desc', {}, '記録のない時間は線が途切れます。グラフにフォーカスして左右の矢印キーで記録を確認できます。'));
  for (const value of [0, 25, 50, 75, 100]) {
    svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'grid' }));
    svg.append(svgNode('text', { x: left - 12, y: y(value) + 4, 'text-anchor': 'end', class: 'axis' }, `${value}`));
  }
  for (const value of [30, 10]) svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: `threshold ${value === 10 ? 'critical' : ''}` }));
  for (let i = 0; i <= 4; i++) {
    const at = range.start + (range.end - range.start) * i / 4;
    const label = range.end - range.start > DAY + 1000 ? shortDate.format(new Date(at)) : shortTime.format(new Date(at));
    svg.append(svgNode('text', { x: x(at), y: bottom + 30, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'axis' }, label));
  }
  let count = 0;
  for (const segment of sampledSegments(points, key, range)) {
    const d = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(2)} ${y(point[key]).toFixed(2)}`).join(' ');
    svg.append(svgNode('path', { d, class: `trace ${key === 'weekly' ? 'weekly' : ''}` }));
    for (const point of segment) {
      count++;
      const circle = svgNode('circle', { cx: x(point.at), cy: y(point[key]), r: segment.length === 1 ? 3.3 : 2.5, class: `dot ${key === 'weekly' ? 'weekly' : ''} ${warningClass(point[key])}` });
      circle.append(svgNode('title', {}, `${fullTime.format(new Date(point.at))} · 残り ${formatValue(point[key])}`));
      circle.addEventListener('pointerenter', () => reading(point, key));
      circle.addEventListener('click', () => reading(point, key));
      svg.append(circle);
    }
  }
  if (!count) svg.append(svgNode('text', { x: (left + right) / 2, y: 112, 'text-anchor': 'middle', class: 'plot-empty' }, state.loading ? '記録を読み込んでいます…' : state.error ? '記録を取得できませんでした' : 'この期間の記録はありません'));
  const available = points.filter(point => Number.isFinite(point[key]));
  svg.setAttribute('tabindex', available.length ? '0' : '-1');
  let cursor = available.length - 1;
  svg.onkeydown = event => {
    if (!available.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    cursor = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : Math.max(0, Math.min(available.length - 1, cursor + (event.key === 'ArrowLeft' ? -1 : 1)));
    reading(available[cursor], key);
  };
}

function render() {
  const open = state.demo || Boolean(state.key);
  $('#unlock-panel').hidden = open; $('#dashboard').hidden = !open; $('#lock').hidden = !open;
  $('#demo-notice').hidden = !state.demo;
  $('#lock').textContent = state.demo ? 'デモを閉じる' : 'ロック';
  if (!open) return;
  const latest = state.latest;
  const last = latest?.points?.at(-1), recordedAt = latest?.recordedAt || last?.at;
  const delayed = Number.isFinite(recordedAt) && Date.now() - recordedAt > 30 * 60 * 1000;
  const dot = $('#status-dot'); dot.className = 'status-dot';
  if (state.loading) { dot.classList.add('loading'); $('#status-text').textContent = '記録を読み込み中…'; }
  else if (state.demo) $('#status-text').textContent = 'デモ · サンプルデータ';
  else if (state.error) { dot.classList.add('error'); $('#status-text').textContent = '記録の確認に失敗しました'; }
  else if (latest?.status === 'login') { dot.classList.add('delayed'); $('#status-text').textContent = 'クラウドのログインを待っています'; }
  else if (latest?.status === 'error') { dot.classList.add('error'); $('#status-text').textContent = 'クラウドでの取得に失敗しています'; }
  else if (delayed) { dot.classList.add('delayed'); $('#status-text').textContent = '記録の更新に遅延があります'; }
  else $('#status-text').textContent = last ? 'クラウドの記録を表示中' : 'まだ記録がありません';
  $('#checked-at').textContent = state.checkedAt ? `${shortTime.format(new Date(state.checkedAt))} 確認` : '';
  $('#refresh').disabled = state.loading; $('#export').disabled = !state.points.length || state.loading;
  const messages = [];
  if (state.error) messages.push(state.error);
  if (latest?.status === 'login') messages.push('PCアプリの「スリープ中の記録を設定」から、クラウドのログインを完了してください。');
  else if (latest?.status === 'error') messages.push('取得済みの記録を表示しています。PCアプリの設定画面で、クラウドの認証・記録状態を確認してください。');
  else if (delayed && !state.demo) messages.push('表示している残量は最後に取得できた時点の値です。GitHubの定期実行は遅延・停止することがあります。');
  if (state.partial) messages.push('過去の記録を一部取得できませんでした。空白は使用量の推定で補っていません。「更新」で再試行できます。');
  $('#data-notice').hidden = !messages.length; $('#data-notice').textContent = messages.join(' ');
  for (const [key, prefix] of [['fiveHour', 'five'], ['weekly', 'week']]) {
    const point = latest?.points?.findLast(item => Number.isFinite(item[key]));
    const value = point?.[key];
    $(`#${prefix}-value`).textContent = formatValue(value); $(`#${prefix}-value`).className = warningClass(value);
    $(`#${prefix}-bar`).setAttribute('width', Number.isFinite(value) ? String(value * 5) : '0');
    $(`#${prefix}-bar`).setAttribute('class', `bar-fill ${warningClass(value)}`);
    $(`#${prefix}-bar`).parentElement.setAttribute('aria-label', `${key === 'fiveHour' ? '5時間枠' : '7日枠'}の残り ${formatValue(value)}`);
    $(`#${prefix}-time`).textContent = point ? `${fullTime.format(new Date(point.at))} の記録` : 'まだ取得できていません';
  }
  const range = state.range || selection();
  $('#range-label').textContent = `${fullDate.format(new Date(range.start))} ${state.days === 1 ? shortTime.format(new Date(range.start)) : ''} 〜 ${fullDate.format(new Date(range.end))} ${state.days === 1 ? shortTime.format(new Date(range.end)) : ''}`;
  $('#record-count').textContent = state.loading ? '読み込み中' : `${state.points.length.toLocaleString('ja-JP')} 件の記録`;
  $('#next').disabled = !$('#end-date').value || $('#end-date').value >= localToday();
  $('#chart-error').textContent = '';
  plot($('#five-chart'), 'fiveHour'); plot($('#week-chart'), 'weekly');
}

async function update({ refreshLatest = false } = {}) {
  if (!state.key && !state.demo) return;
  const id = ++state.request;
  state.controller?.abort(); state.controller = new AbortController();
  const signal = state.controller.signal, range = selection();
  const changed = !state.range || range.start !== state.range.start || range.end !== state.range.end;
  state.range = range; state.loading = true; state.error = '';
  if (changed) { state.points = []; state.partial = false; $('#reading').textContent = 'グラフ上の点を選ぶと、記録時刻と残量を確認できます。'; }
  render();
  try {
    if (state.demo) {
      const latestRange = { start: Date.now() - DAY, end: Date.now() };
      state.latest = { status: 'ready', points: makeDemo(latestRange), recordedAt: latestRange.end };
      state.points = makeDemo(range); state.partial = false; state.missingDays = [];
    } else {
      const key = state.key;
      if (refreshLatest || !state.latest) {
        const latest = await loadLatest(key, { signal });
        if (id !== state.request) return;
        const accountChanged = latest.account !== state.latest?.account;
        if (accountChanged) {
          state.points = []; state.partial = false; state.missingDays = [];
          $('#reading').textContent = 'グラフ上の点を選ぶと、記録時刻と残量を確認できます。';
        }
        state.latest = latest;
        if (accountChanged) render();
      }
      const result = await loadRange(key, state.latest, range, { signal, onProgress: progress => {
        if (id === state.request && progress.total) $('#record-count').textContent = `過去の記録 ${progress.loaded} / ${progress.total} 日`;
      } });
      if (id !== state.request) return;
      state.points = result.points; state.partial = result.partial; state.missingDays = result.missingDays;
    }
    if (id !== state.request) return;
    state.checkedAt = Date.now();
  } catch (error) {
    if (id !== state.request || error.name === 'AbortError') return;
    state.error = 'クラウドの記録を読み込めませんでした。通信状態と記録の設定を確認し、もう一度更新してください。';
  } finally { if (id === state.request) { state.loading = false; render(); } }
}

function lock() {
  state.request++; state.controller?.abort();
  Object.assign(state, { key: null, demo: false, latest: null, points: [], partial: false, missingDays: [], range: null, checkedAt: null, loading: false, error: '' });
  $('#recording-key').value = ''; $('#recording-key').type = 'password';
  $('#toggle-key').textContent = '表示'; $('#toggle-key').setAttribute('aria-pressed', 'false'); $('#toggle-key').setAttribute('aria-label', '閲覧キーを表示');
  $('#unlock-error').textContent = ''; $('#unlock').disabled = false; $('#unlock').textContent = '記録を表示する →';
  $('#end-date').value = ''; $('#reading').textContent = 'グラフ上の点を選ぶと、記録時刻と残量を確認できます。';
  $('#five-chart').replaceChildren(); $('#week-chart').replaceChildren();
  for (const svg of [$('#five-chart'), $('#week-chart')]) { svg.onkeydown = null; svg.setAttribute('tabindex', '-1'); }
  for (const prefix of ['five', 'week']) {
    $(`#${prefix}-value`).textContent = '—'; $(`#${prefix}-value`).className = '';
    $(`#${prefix}-bar`).setAttribute('width', '0'); $(`#${prefix}-bar`).setAttribute('class', 'bar-fill');
    $(`#${prefix}-time`).textContent = '記録を待っています';
  }
  $('#data-notice').textContent = ''; $('#status-text').textContent = ''; $('#checked-at').textContent = '';
  $('#record-count').textContent = ''; $('#range-label').textContent = ''; $('#chart-error').textContent = '';
  render(); $('#recording-key').focus();
}

$('#unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = ++state.request; state.controller?.abort(); state.controller = new AbortController();
  const signal = state.controller.signal;
  $('#unlock-error').textContent = ''; $('#unlock').disabled = true; $('#unlock').textContent = '記録を確認しています…';
  try {
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) throw new Error('secure-context');
    const key = await unlockKey($('#recording-key').value.trim());
    if (id !== state.request) return;
    const latest = await loadLatest(key, { signal });
    if (id !== state.request) return;
    state.key = key; state.demo = false; state.latest = latest; $('#recording-key').value = '';
    await update();
  } catch (error) {
    if (id !== state.request || error.name === 'AbortError') return;
    $('#unlock-error').textContent = error.message === 'secure-context' ? 'このブラウザでは安全に復号できません。HTTPSでこのページを開いてください。' : '記録を開けませんでした。キーの入力、GitHubでの記録設定、通信状態を確認してください。';
  } finally {
    if (!state.key && !state.demo) { $('#unlock').disabled = false; $('#unlock').textContent = '記録を表示する →'; }
  }
});
$('#toggle-key').addEventListener('click', () => {
  const shown = $('#recording-key').type === 'password'; $('#recording-key').type = shown ? 'text' : 'password';
  $('#toggle-key').textContent = shown ? '隠す' : '表示'; $('#toggle-key').setAttribute('aria-pressed', String(shown)); $('#toggle-key').setAttribute('aria-label', shown ? '閲覧キーを隠す' : '閲覧キーを表示');
});
$('#demo').addEventListener('click', () => { state.request++; state.controller?.abort(); state.key = null; state.demo = true; state.error = ''; $('#recording-key').value = ''; void update(); });
$('#lock').addEventListener('click', lock); $('#exit-demo').addEventListener('click', lock);
$('#refresh').addEventListener('click', () => void update({ refreshLatest: true }));
for (const button of document.querySelectorAll('[data-days]')) button.addEventListener('click', () => {
  state.days = Number(button.dataset.days);
  for (const item of document.querySelectorAll('[data-days]')) { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }
  void update();
});
$('#end-date').addEventListener('change', () => {
  if ($('#end-date').value > localToday()) $('#end-date').value = localToday();
  void update();
});
$('#latest').addEventListener('click', () => { $('#end-date').value = ''; void update({ refreshLatest: true }); });
for (const [selector, direction] of [['#previous', -1], ['#next', 1]]) $(selector).addEventListener('click', () => {
  const input = $('#end-date'), date = input.value ? new Date(`${input.value}T12:00:00`) : new Date();
  date.setDate(date.getDate() + direction * state.days);
  input.value = localDate(date) > localToday() ? localToday() : localDate(date); void update();
});
$('#export').addEventListener('click', () => {
  if (!state.points.length || state.loading) return;
  const file = new Blob([historyCsv(state.points)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(file), link = document.createElement('a');
  link.href = url; link.download = `${state.demo ? 'demo-' : ''}codex-usage-${localDate(new Date(state.range.start))}-${localDate(new Date(state.range.end))}.csv`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('#reading').textContent = `${state.points.length.toLocaleString('ja-JP')}件の${state.demo ? 'デモ記録' : '記録'}をCSVに書き出しました。`;
});
setInterval(() => { $('#end-date').max = localToday(); if (!document.hidden && !state.loading && state.key) void update({ refreshLatest: true }); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.key && !state.loading && (!state.checkedAt || Date.now() - state.checkedAt > 60000)) void update({ refreshLatest: true }); });
window.addEventListener('resize', () => { if (state.key || state.demo) { plot($('#five-chart'), 'fiveHour'); plot($('#week-chart'), 'weekly'); } });
render();

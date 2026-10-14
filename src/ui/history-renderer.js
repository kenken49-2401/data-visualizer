'use strict';
const NS = 'http://www.w3.org/2000/svg';
let requestId = 0, selectedRange = null;
const time = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function node(tag, attrs = {}, text = '') {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  element.textContent = text; return element;
}
function plot(svg, data, key) {
  svg.replaceChildren();
  const x = at => 46 + (at - data.start) / (data.end - data.start) * 608;
  const y = value => 144 - value / 100 * 128;
  for (const value of [0, 25, 50, 75, 100]) {
    svg.append(node('line', { x1: 46, x2: 654, y1: y(value), y2: y(value), class: 'grid' }));
    svg.append(node('text', { x: 38, y: y(value) + 4, 'text-anchor': 'end', class: 'axis' }, `${value}%`));
  }
  for (const value of [30, 10]) svg.append(node('line', { x1: 46, x2: 654, y1: y(value), y2: y(value), class: value === 10 ? 'threshold critical' : 'threshold' }));
  for (let i = 0; i <= 4; i++) {
    const at = data.start + (data.end - data.start) * i / 4;
    const label = data.end - data.start > 86400000 ? new Date(at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    svg.append(node('text', { x: x(at), y: 169, class: 'axis', 'text-anchor': 'middle' }, label));
  }
  let count = 0;
  for (const segment of sampleHistory(data.points, key, data.start, data.end)) {
    let d = '';
    for (const point of segment) d += d ? ` H${x(point.at)} V${y(point[key])}` : `M${x(point.at)} ${y(point[key])}`;
    svg.append(node('path', { d, class: 'trace' }));
    for (const point of segment) {
      count++;
      const label = `${time.format(new Date(point.at))} · 残り ${Math.round(point[key] * 10) / 10}%`;
      const circle = node('circle', { cx: x(point.at), cy: y(point[key]), r: 2.7, class: 'dot' + (point[key] <= 10 ? ' critical' : point[key] <= 30 ? ' warning' : '') });
      circle.append(node('title', {}, label));
      circle.addEventListener('pointerenter', () => { document.querySelector('#reading').textContent = label; });
      circle.addEventListener('click', () => { document.querySelector('#reading').textContent = label; });
      svg.append(circle);
    }
  }
  if (!count) svg.append(node('text', { x: 350, y: 83, class: 'empty' }, data.cloud?.archiveStatus === 'loading' ? '過去の記録を読み込んでいます…' : !data.earliestAt ? 'まだ記録がありません。取得した残量から表示します。' : 'この期間の記録はありません。日付や期間を変えてください。'));
}
function render(data) {
  document.querySelector('#range').textContent = `${time.format(new Date(data.start))} 〜 ${time.format(new Date(data.end))} · ${data.totalPoints ?? data.points.length}件` + (data.earliestAt ? ` · 保存開始 ${new Date(data.earliestAt).toLocaleDateString('ja-JP')}` : '');
  document.querySelector('#export').disabled = !data.points.length || data.accountPending || data.cloud?.archiveStatus === 'loading';
  const cloud = data.cloud || {};
  const statuses = { ready: 'クラウドの記録を同期しています。', delayed: 'クラウドの記録に遅延があります。', 'account-mismatch': 'クラウドとPCのアカウントが異なるため、同期していません。', unavailable: 'クラウドの履歴を取得できません。PC側の記録を続けています。', 'recording-error': 'クラウドで取得に失敗しました。設定を確認してください。' };
  document.querySelector('#cloud-status').textContent = cloud.archiveStatus === 'loading' ? '過去のクラウド記録を読み込んでいます…' : cloud.archiveStatus === 'error' ? '過去のクラウド記録を一部取得できませんでした。期間を選び直すと再試行します。' : statuses[cloud.status] || '';
  const last = data.points.at(-1);
  document.querySelector('#updated').textContent = last ? `${time.format(new Date(last.at))} 取得` : '';
  document.querySelector('#notice').textContent = data.demo ? 'デモ表示 · 実際の使用量ではありません' : data.accountPending ? 'ログイン先を確認でき次第、履歴を記録します。' : data.sessionOnly ? 'アカウント識別情報がないため、この起動中の履歴のみです。' : data.saveError ? '履歴の一部を読み込み・保存できません。取得できた記録を表示しています。' : '';
  for (const [key, prefix] of [['fiveHour', 'five'], ['weekly', 'week']]) {
    const value = last?.[key];
    document.querySelector(`#${prefix}-value`).textContent = Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : '—';
    plot(document.querySelector(`#${prefix}-chart`), data, key);
  }
}
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
document.querySelector('#day').max = localDate(new Date());
async function request(range) {
  const id = ++requestId; document.querySelector('#history-error').textContent = '';
  try { const data = await window.usageHistory.get(range); if (id === requestId) { selectedRange = range ?? null; render(data); } }
  catch { if (id === requestId) document.querySelector('#history-error').textContent = '履歴を取得できませんでした。期間を選び直してください。'; }
}
function selection() {
  const day = document.querySelector('#day').value;
  if (day) { const end = new Date(`${day}T00:00:00`); end.setDate(end.getDate()+1); const start = new Date(end); start.setDate(start.getDate()-Number(document.querySelector('#period').value)); return { start: start.getTime(), end: end.getTime()-1 }; }
  const end = Date.now(); return { start: end - Number(document.querySelector('#period').value)*86400000, end };
}
window.usageHistory.subscribe(data => { if (selectedRange && (data.start !== selectedRange.start || data.end !== selectedRange.end)) return; render(data); });
void request();
setInterval(() => { document.querySelector('#day').max = localDate(new Date()); void request(document.querySelector('#day').value ? selection() : Number(document.querySelector('#period').value) === 1 ? null : selection()); }, 60000);
document.querySelector('#period').onchange = () => { void request(selection()); };
document.querySelector('#day').onchange = () => { if (document.querySelector('#day').value) void request(selection()); };
document.querySelector('#latest').onclick = () => { document.querySelector('#day').value = ''; document.querySelector('#period').value = '1'; void request(); };
for (const [id, step] of [['previous',-1],['next',1]]) document.querySelector(`#${id}`).onclick = () => {
  const input = document.querySelector('#day'), date = input.value ? new Date(`${input.value}T00:00:00`) : new Date(); date.setDate(date.getDate()+step*Number(document.querySelector('#period').value));
  input.value = localDate(date) > localDate(new Date()) ? localDate(new Date()) : localDate(date); void request(selection());
};
document.querySelector('#export').onclick = async () => {
  document.querySelector('#history-error').textContent = '';
  try { const result = await window.usageHistory.export(); if (result.saved) document.querySelector('#reading').textContent = `${result.count}件をCSVに保存しました。`; }
  catch { document.querySelector('#history-error').textContent = 'CSVを保存できませんでした。保存先を確認してください。'; }
};

document.querySelector('#cloud-setup').onclick = () => void window.usageHistory.cloud();

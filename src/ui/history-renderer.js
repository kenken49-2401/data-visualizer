'use strict';
const NS = 'http://www.w3.org/2000/svg';
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
    const label = new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    svg.append(node('text', { x: x(at), y: 169, class: 'axis', 'text-anchor': 'middle' }, label));
  }
  let count = 0;
  for (const segment of historySegments(data.points, key)) {
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
  if (!count) svg.append(node('text', { x: 350, y: 83, class: 'empty' }, 'まだ記録がありません。取得した残量から表示します。'));
}
function render(data) {
  const cloud = data.cloud || {};
  const statuses = { ready: 'クラウドの記録を同期しています。', delayed: 'クラウドの記録に遅延があります。', 'account-mismatch': 'クラウドとPCのアカウントが異なるため、同期していません。', unavailable: 'クラウドの履歴を取得できません。PC側の記録を続けています。', 'recording-error': 'クラウドで取得に失敗しました。設定を確認してください。' };
  document.querySelector('#cloud-status').textContent = statuses[cloud.status] || '';
  const last = data.points.at(-1);
  document.querySelector('#updated').textContent = last ? `${time.format(new Date(last.at))} 取得` : '';
  document.querySelector('#notice').textContent = data.demo ? 'デモ表示 · 実際の使用量ではありません' : data.accountPending ? 'ログイン先を確認でき次第、履歴を記録します。' : data.sessionOnly ? 'アカウント識別情報がないため、この起動中の履歴のみです。' : data.saveError ? '履歴を保存できません。現在の起動中の記録を表示しています。' : '';
  for (const [key, prefix] of [['fiveHour', 'five'], ['weekly', 'week']]) {
    const value = last?.[key];
    document.querySelector(`#${prefix}-value`).textContent = Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : '—';
    plot(document.querySelector(`#${prefix}-chart`), data, key);
  }
}
window.usageHistory.subscribe(render);
window.usageHistory.get().then(render);
setInterval(() => { void window.usageHistory.get().then(render); }, 60000);

document.querySelector('#cloud-setup').onclick = () => void window.usageHistory.cloud();

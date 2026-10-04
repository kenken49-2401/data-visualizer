'use strict';
let currentState;
const formatter = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });
function render(state) {
  currentState = state;
  const threshold = Math.max(120000, (state.settings?.intervalSeconds ?? 60) * 2000 + 10000);
  const old = state.status === 'ready' && Date.now() - state.updatedAt > threshold;
  const status = old ? 'stale' : state.status;
  document.body.dataset.status = status;
  document.body.dataset.size = state.settings?.size ?? 'compact';
  const stamp = state.updatedAt ? timeFormatter.format(new Date(state.updatedAt)) : '';
  const labels = { loading: '使用量を取得中…', ready: `残り割合 · ${stamp} 更新 · ${(state.settings?.intervalSeconds ?? 60) / 60}分ごと`,
    demo: 'デモ表示 · 実際の使用量ではありません',
    stale: `前回の取得値 · ${stamp} / ${state.error?.text ?? '再取得待ち'}`,
    error: state.error?.text ?? '使用量を取得できません' };
  const statusElement = document.querySelector('#status');
  statusElement.textContent = state.loginPending ? 'ブラウザでログインを完了してください' : labels[status];
  statusElement.title = statusElement.textContent;
  for (const key of ['fiveHour', 'weekly']) {
    const section = document.querySelector(`[data-window="${key}"]`);
    const quota = state.usage?.[key];
    section.querySelector('.value').textContent = quota ? `${Math.round(quota.remainingPercent * 10) / 10}%` : '—';
    section.querySelector('.fill').style.width = quota ? `${quota.remainingPercent}%` : '0%';
    section.dataset.level = quota && quota.remainingPercent <= 10 ? 'critical' : quota && quota.remainingPercent <= 30 ? 'warning' : 'normal';
    const progress = section.querySelector('.track');
    if (quota) progress.setAttribute('aria-valuenow', String(quota.remainingPercent)); else progress.removeAttribute('aria-valuenow');
    const reset = section.querySelector('.reset');
    const hasDate = quota?.resetsAt && Number.isFinite(new Date(quota.resetsAt).getTime());
    reset.textContent = hasDate ? `リセット ${formatter.format(new Date(quota.resetsAt))}${Date.now() >= quota.resetsAt ? ' · 再取得待ち' : ''}` : 'リセット時刻：不明';
    reset.title = hasDate ? new Date(quota.resetsAt).toLocaleString('ja-JP') : '';
  }
  document.querySelector('#login').hidden = state.status !== 'error' || state.error?.kind !== 'auth';
  document.querySelector('#login').disabled = state.loginPending;
  document.querySelector('#cancel-login').hidden = !state.loginPending;
  document.querySelector('#refresh').disabled = state.status === 'demo';
  document.querySelector('#restart').hidden = state.update?.status !== 'ready';
  const placement = document.querySelector('#placement');
  placement.textContent = state.update?.status === 'ready' ? '改善版を受信済み' : state.placement === 'manual' ? '自由位置' : state.placement === 'app' ? 'アプリに追従' : '画面左下';
  const updates = { checking: 'アプリの更新を確認中', downloading: '改善版をダウンロード中', preparing: '改善版の起動を確認中', ready: `改善版 ${state.update?.available} を次回起動時に適用`, error: 'アプリの更新確認に失敗。現在の版を引き続き使用します' };
  placement.title = [`バージョン ${state.version ?? ''}`, updates[state.update?.status] ?? '', state.settingsError ? '設定を保存できませんでした' : '', state.trackerFailed ? 'ChatGPTの表示状態を確認できません。トレイから設定を変更できます' : ''].filter(Boolean).join('\n');
}
window.usageOverlay.subscribe(render);
window.usageOverlay.getState().then(render);
for (const [id, action] of [['hide', 'hide'], ['minimize', 'minimize'], ['menu', 'menu'], ['login', 'login'], ['cancel-login', 'cancelLogin'], ['restart', 'restart']]) {
  document.querySelector(`#${id}`).addEventListener('click', () => void window.usageOverlay[action]());
}
document.querySelector('#refresh').addEventListener('click', async () => {
  const button = document.querySelector('#refresh'); button.disabled = true;
  try { await window.usageOverlay.refresh(); } finally { button.disabled = false; }
});
setInterval(() => { if (currentState) render(currentState); }, 15000);

'use strict';
const api = window.cloudRecording;
const labels = { disabled: '未設定です。手順1から設定してください。', waiting: '設定を確認中です。', unavailable: 'まだ記録を取得できません。鍵・GitHubの設定・実行結果を確認してください。', ready: 'クラウドの記録を取得できました。', delayed: 'クラウドの記録が30分以上更新されていません。Actionsの実行状況を確認してください。', login: '認証コードが届きました。手順3からログインしてください。', 'login-expired': '認証の待ち時間が終了しました。login を再実行してください。', 'recording-error': 'クラウドで取得に失敗しました。Actionsの結果を確認し、必要に応じてloginを再実行してください。', 'account-mismatch': 'PCとクラウドのアカウントが異なります。履歴は取り込みません。同じアカウントでloginしてください。', 'account-pending': 'クラウドで記録できています。PC側のログイン確認後に履歴を取り込みます。', 'config-error': '保存した鍵を開けません。保管した鍵で再接続してください。' };
function render(data) {
  document.querySelector('#status').textContent = (labels[data.status] || '接続を確認してください。') + (data.recordedAt ? ` 最後の記録：${new Date(data.recordedAt).toLocaleString('ja-JP')}` : '');
  document.querySelector('#generate').disabled = data.configured || !data.available;
  document.querySelector('#disable').disabled = !data.configured;
  document.querySelector('#challenge').hidden = !data.challenge;
  document.querySelector('#code').textContent = data.challenge?.userCode || '';
  if (!data.available) document.querySelector('#error').textContent = 'OSの暗号化保存が利用できません。このPCでは設定できません。';
}
async function action(fn) { document.querySelector('#error').textContent = ''; try { await fn(); } catch { document.querySelector('#error').textContent = '設定できませんでした。入力した鍵とWindowsの保存先を確認してください。'; } }
document.querySelector('#generate').onclick = () => action(async () => { const key = await api.generate(); document.querySelector('#master').value = key; document.querySelector('#key-panel').hidden = false; });
document.querySelector('#install').onclick = () => action(async () => { await api.install(document.querySelector('#existing').value.trim()); document.querySelector('#existing').value = ''; });
document.querySelector('#disable').onclick = () => action(async () => { await api.disable(); document.querySelector('#master').value = ''; document.querySelector('#key-panel').hidden = true; });
document.querySelector('#check').onclick = () => action(() => api.check());
for (const button of document.querySelectorAll('[data-open]')) button.onclick = () => action(() => api.open(button.dataset.open));
api.subscribe(render); api.get().then(render);
setInterval(() => { void api.check().catch(() => {}); }, 10000);

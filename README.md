# Codex 残り使用量 — Windows オーバーレイ

Codex の **5時間枠・7日間枠の残り割合とリセット時刻**を、Windows の左下に表示する補助アプリです。ChatGPT / Codex アプリのウィンドウ左下に追従するモードと、画面左下に常駐するモードがあります。公式アプリへの組み込みではなく、別ウィンドウを重ねて表示します。

## Windows で使う

1. **Node.js 22.12 以上**（LTS 推奨）をインストールします。
2. このプロジェクトを Windows にコピー・展開し、`start.cmd` をダブルクリックします。初回はロックファイルに沿って必要なパッケージを取得します。
3. 同じ Plus アカウントで Codex CLI にログイン済みなら、そのログイン状態で取得を試みます。未ログインなら表示の「ログイン」、または通知領域のアイコンを右クリックして「ChatGPT アカウントでログイン」を選び、ブラウザでログインします。
4. 画面左下に残り割合が表示されます。Windows の **通知領域のアイコン → 表示位置**で、画面左下とアプリへの追従を切り替えられます。

追従モードは `ChatGPT.exe` / `Codex.exe` のウィンドウを対象にします。対象アプリが前面にあるときに表示し、最小化時や別アプリが前面のときには隠します。対象が見つからない場合や追従できない場合は画面左下に表示します。追従モードで幅の狭いウィンドウを使用する場合は、画面左下モードを選んでください。アプリ内の操作領域に重なることがあります。

常に見える表示にしたい場合は **「画面左下に常に表示」**を選びます。終了はパネルの × または通知領域の「終了」です。Windows 起動時の自動起動登録は行いません。

PowerShell から起動する場合は、プロジェクトのフォルダで実行します。

```powershell
npm.cmd ci
npm.cmd run install:electron
npm.cmd start
```

Windows の npm PowerShell スクリプトが実行ポリシーで拒否される場合も、上記の `.cmd` を使えばポリシーを変更する必要はありません。別 OS の `node_modules` はコピーせず、Windows 側で `npm ci` を実行してください。

## 取得する情報

OpenAI の [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) に、ローカルの標準入出力で接続します。

- `initialize` → `initialized` の後、`account/rateLimits/read` を読み取ります。
- `rateLimitsByLimitId.codex` があればそれを選び、互換用の `rateLimits` にも対応します。
- `windowDurationMins` が `300` / `10080` の枠を、それぞれ5時間 / 7日間として扱います。
- `usedPercent` から `max(0, 100 − usedPercent)` を計算します。回数・トークン数の残量は推定しません。
- `resetsAt` は Unix 秒を日時に変換し、Windows のローカル時間で表示します。

通常は60秒ごとに更新します。更新通知があれば完全なデータを読み直します。失敗時は間隔を最大5分まで延ばし、前回の値を残す場合は明示します。ログインが失われた場合・アカウント更新時には前回の値を消します。リセット時刻を過ぎても取得するまで残量を100%には戻しません。期間や数値が未提供なら `—` / 不明と表示します。

公式 Codex CLI `0.160.0` を依存関係に固定しています。app-server の仕様はバージョンにより変わる可能性があります。取得するアカウントは Codex CLI のログイン先です。デスクトップアプリも同じアカウント・ワークスペースを使っていることを確認してください。

## 認証・データの扱い

ログインと資格情報の管理は Codex に任せます。このアプリは認証ファイルからトークンを取り出したり、独自の認証ストアへコピーしたりしません。読み取った残量はメモリ内で表示し、ファイルに保存しません。会話の内容は読み取りません。

画面から外部通信や Node.js への直接アクセスはできません。ログイン時だけ、Codex が返す `https://auth.openai.com/` の認証 URL を既定のブラウザで開きます。Codex 本体は公式サービスへ通信し、通常の Codex の認証・設定ファイルを使用します。Windows のウィンドウ追従用 PowerShell はウィンドウの位置と前面状態を読み取ります。

## 開発・確認

既存のチェックアウトを使用してください。クラウドタスクは隔離済みなので、別の Git worktree は不要です。

```sh
npm ci
npm run install:electron
npm test
npm run demo
npm run probe
```

`demo` は架空の値を表示し、ログインや通信をしません。`probe` は実際の Codex アカウントから残量を取得します。両枠を確認できなければ非ゼロで終了します。デモの成功は実アカウントの取得成功を意味しません。

GUI の動作確認は `npm run smoke` で実行します。Linux で画面がない場合は、Xorg・dummy ドライバー・`xdpyinfo` を利用して一時的な仮想画面を起動し、終了後に停止します。スクリーンショットはコマンドが出力する一時ディレクトリに残します。

このクラウド環境では Chromium の SUID サンドボックスを使えないため、**通信しないデモ検証限定**で以下を実行します。通常起動のコマンドや Windows にはこのフラグを追加しません。

```sh
npm run smoke -- --cloud-no-sandbox
```

このクラウド環境では npm と Electron のキャッシュを `/workspace/.cache` に置き、Node.js の標準プロキシ対応を有効にします。TLS・ダウンロードのチェックサム検証は有効なままです。

```sh
NODE_USE_ENV_PROXY=1 electron_config_cache=/workspace/.cache/electron npm --cache /workspace/.cache/npm ci
NODE_USE_ENV_PROXY=1 electron_config_cache=/workspace/.cache/electron npm run install:electron
```

### 確認状況

- Linux クラウド：残量処理・通信処理・取得失敗・アカウント切替の自動テストを実行。
- Linux クラウド：Electron のデモ表示・ログイン要求表示・古い取得値の表示・画面内レイアウトを実画面で検証。
- 実アカウント：この環境で app-server の接続確認がタイムアウト。公開 CLI を認証なしの一時設定で診断すると、クラウドの読み取り専用ディレクトリへの書き込みで停止しました。CLI の通常のローカル設定を作れる Windows 実機での検証が必要です。Plus アカウントの5時間・7日間枠の取得成功は未確認。
- Windows：実機の追従、DPI、ブラウザログイン、実使用量の取得は未確認。

Windows で最後の2項目を確認するまでは、実アカウントで動作確認済みとは扱いません。

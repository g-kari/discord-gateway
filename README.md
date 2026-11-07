# discord-gateway — Discord と Agent 群をつなぐ常駐の耳と口

ユーザーの Agent メッシュ（クロワッサンド／dots など）向けの共有フロントエンド。Cloudflare Worker + Durable Object として実装し、Discord Bot として常時 Gateway に接続して、Bot 宛の発言を dots-events 経由でクロワッサンドへの依頼に変換する。このリポジトリの自動テストはローカル代替サービスまでを対象とし、実Discordと本番環境での疎通は別途確認が必要。

- 実装: [worker.js](./worker.js)（単一ファイル、ランタイム依存なし。自動テストのみ `test/` 配下で Miniflare を devDependency として使用）
- 受け渡し先: 既定では dots-events の `POST https://dots-events.0g0.xyz/claude-hook`（Standard Webhooks 署名つき。受信側は `request_id` で重複排除する）。環境変数 `FORWARD_MODE=trigger` のデプロイでは `POST https://dots-events.0g0.xyz/trigger`（Bearer 認証、署名なし）に切り替わる（後述「2台目のBot」参照）

## 構成

- Cloudflare Worker `discord-gateway`。HTTP の入口（`/status`、`/connect`、`/send`）だけを担う。
- 永続化と Gateway 接続は **Durable Object（SQLite、クラス `Gateway`、グローバル単一インスタンス）に集約**。接続状態（session_id、resume URL、最終 seq、bot のユーザー ID）と、転送に失敗した依頼の outbox を SQLite に保存する。再デプロイやオブジェクト再起動後は永続化した状態でセッション再開（Resume）を試みる。
- Gateway 接続は **通常の外向き WebSocket クライアント**（`fetch` Upgrade、`ws.accept()` と標準イベントリスナー）で保持する。Cloudflareの[公式仕様](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)では、外向き接続はハイバネーション非対応。接続中はDurable Objectの実行時間課金が発生する。Hello（op 10）でハートビート間隔を受け取り、DO の alarm でハートビート（op 1）を回す。ACK が返らない接続はゾンビとして切り、Resume（op 6）で再接続する。Hello後の初回ハートビートにはjitterを加える。ハンドシェイク監視はREADY/RESUMEDで解除する。切断時はclose codeに応じてセッションを保持／破棄し、バックオフつきで再接続する。4011を含むfatal codeでは自動再接続を停止し、原因修正後の管理キー付き`POST /connect`で再開する。alarm は接続の自己復旧（self-start）も兼ねる。
- 生存監視はハートビート ACK だけでなく、**最終 DISPATCH 時刻**も見る。ACK は返るのにイベントが4時間届かない「聞こえないソケット」は強制的に張り直す（Resume するので実害は小さい）。

## 動作

### 入口（Discord → Muse）

- 対象: **DM**、または **Bot がメンションされたギルドメッセージ**。Bot 自身と他の Bot の発言は無視する。
- 転送 body: `{"text", "topic": "discord", "request_id": "discord-<message id>"}`。`text` の1行目は `[discord channel:<channel_id> guild:<guild_id or -> author:<username>]` で、本文から Bot メンションを取り除く。コードのインデントなど本文内の空白は保持する。返信先チャンネルはこの行で分かる。
- 署名: Standard Webhooks（`webhook-id` / `webhook-timestamp` / `webhook-signature`、HMAC-SHA256）。dots-kick-events の実装と同一形式。`FORWARD_MODE=trigger` の場合は署名せず、`Authorization: Bearer <EVENTS_TRIGGER_KEY>` で `/trigger` に送る。
- 転送はまずoutboxに永続化し、alarmからロック外のバックグラウンド配送を開始する。転送先の応答待ち中もACK・heartbeat・status処理を続け、1試行のタイムアウトは10秒。失敗はoutboxに残し、最大5回まで再試行する（受信側が `request_id` で重複排除するので再送は安全）。受信側が 429 を返したら `Retry-After` を尊重する。例外として trigger モードでは、429 以外の 4xx は「依頼自体が拒否された」として再試行せず、その時点で失敗として `forward_log` に記録する（再生で再送されてきても再投入しない）。
- 転送済みの `request_id` は `forward_log` に1週間保持し、Resume 再生で同じメッセージが再送されてきたらローカルで弾く（受信側の重複排除と二重化）。

### 出口（Agent → Discord）

- `POST /send`（管理キー認証）に `{"channel_id", "content"}` を送ると、Discord REST `POST /channels/{channel_id}/messages` を Bot トークンで呼ぶ。`content` が Discord の上限（2000文字）を超える場合は切り捨てず、改行・空白の境界で複数メッセージに分割して順に送る（分割数は最大10件、超過分は切り捨て通知に置換）。Discord が 429 を返したら `retry_after`（body → `Retry-After` → `X-RateLimit-Reset-After` の順）だけ待って同じチャンクを再送する（最大3試行）。待機が30秒を超える場合は早期再送せず429を呼び出し元へ返す。`allowed_mentions.parse`は空にして返信本文による意図しない一斉通知を抑止する。
- 応答: 単一メッセージの場合は Discord の応答ステータスと body をそのまま返す。分割した場合は `{"message_ids": [...], "chunks": n}` を返す。途中のチャンクで失敗したら、送信済み ID と失敗した Discord のステータスを返す。

### HTTP エンドポイント

| ルート | 認証 | 内容 |
|---|---|---|
| `GET /status` | 公開 | `{"connected": bool, "ready": bool}` のみ（ID・秘密情報は出さない） |
| `POST /connect` | 管理キー | Durable Object に（再）接続を促す |
| `POST /send` | 管理キー | 上記の出口 |

管理キーは dots-events の `/trigger` と同じ作法（`Authorization: Bearer <key>` または `X-Trigger-Key` ヘッダ、定数時間比較）。

## 環境変数・シークレット（名前のみ。値はリポジトリに書かない）

| 名前 | 種別 | 用途 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | シークレット（要設定） | Discord Bot トークン。Gateway の Identify と REST 呼び出しに使う |
| `FORWARD_MODE` | 変数（任意） | 転送モード。`claude-hook`（既定）または `trigger` |
| `CLAUDE_HOOK_SECRET` | シークレット（`FORWARD_MODE=claude-hook` のとき要設定） | dots-events の `/claude-hook` と共有する `whsec_` HMAC 秘密 |
| `EVENTS_TRIGGER_KEY` | シークレット（`FORWARD_MODE=trigger` のとき要設定） | dots-events の `/trigger` 用 Bearer キー |
| `ADMIN_KEY` | シークレット（要設定） | `POST /connect` と `POST /send` の管理キー |

## 2台目のBot（dots用デプロイ）

同じ Worker を別デプロイすることで、dots（一姫）の Discord Bot の耳・口にもなれる。dots 側の Bot へのメンション／DM は、クロワッサンド宛の `/claude-hook` ではなく、dots-events の `/trigger` 経由で「dots への依頼」として投入する（`/claude-hook` とその秘密はクロワッサンド側専用なので、2台目には持たせない）。

2台目のデプロイ設定:

- `DISCORD_BOT_TOKEN`: dots の Bot のトークン
- `FORWARD_MODE=trigger`
- `EVENTS_TRIGGER_KEY`: dots-events の `/trigger` 用キー
- `ADMIN_KEY`: そのデプロイ専用の管理キー
- `CLAUDE_HOOK_SECRET` は設定しない（未設定でも trigger モードでは構成済みと判定される）

転送 body は1台目と同一（`{"text", "topic": "discord", "request_id": "discord-<message id>"}`）。返信は1台目と同様に、そのデプロイの `POST /send`（管理キー認証）から dots の Bot として投稿する。

## デプロイ手順（参照）

dots-events と同様に gizen（ユーザーの PC）から wrangler で行う想定。

```powershell
cd C:\Users\gizen\workspace\discord-gateway
npx --yes wrangler@4.149.0 secret put DISCORD_BOT_TOKEN
npx --yes wrangler@4.149.0 secret put CLAUDE_HOOK_SECRET
npx --yes wrangler@4.149.0 secret put ADMIN_KEY
npx --yes wrangler@4.149.0 deploy
```

（2台目の trigger モードでは `CLAUDE_HOOK_SECRET` の代わりに `EVENTS_TRIGGER_KEY` を設定し、`FORWARD_MODE=trigger` を変数として与える。）

デプロイ後、`POST /connect`（管理キー）で初回接続を促し、`GET /status` が `{"connected": true, "ready": true}` になることを確認する。現状 `wrangler.toml` にルートはなく、`workers_dev = false` にしてある（公開経路は別途決める）。

## Discord Developer Portal 側の手順（人間が行う）

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application を作成する。
2. Bot タブで Bot を追加し、トークンを発行する（トークンは Secure Vault 等の安全な場所にだけ保存し、チャットやリポジトリに貼らない）。
3. Bot タブの **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を有効化する（これがないとメッセージ本文が空で届き、メンション判定も本文転送もできない）。本実装の intents は `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES`（37377）。
4. OAuth2 → URL Generator で scope に `bot` を選び、Bot Permissions に **View Channel**、**Send Messages**、**Read Message History** を付けて、生成された URL から対象サーバーに Bot を招待する。
5. 発行したトークンを Worker のシークレット `DISCORD_BOT_TOKEN` に設定する（上記デプロイ手順）。

## テスト

```bash
npm install
npm test
```

Miniflareと純関数の単体テスト（`test/gateway.test.mjs`）に加え、`test/lifecycle.test.mjs`では固定依存版workerd内のローカルDiscord代替と実際のWebSocketを使い、Hello→Identify→READY、Resume、fatal停止、遅いWebhook配送中のheartbeat/ACK/statusと重複排除を検証する。`test/forward-mode.test.mjs`では `FORWARD_MODE` の振り分け（既定=署名つき `/claude-hook`、trigger=Bearer で `/trigger`・署名ヘッダなし）と、trigger モードの再試行分類（429以外の4xxは終了、5xxは再試行）を検証する。署名形式が dots-kick-events と一致すること、MESSAGE_CREATE のフィルタ（自他の Bot を無視／DM を転送／メンションを転送／通常発言を無視）、Gateway プロトコルの判断（Hello→Identify／Resume、READY のセッション保存、Invalid Session の可否、ハートビート ACK 欠落時の再接続、fatal close code でのセッション破棄、4014 の案内文、DISPATCH 無音時の再接続判断）、`/send` の認証拒否・2000文字超の分割送信・429 リトライ、2000文字分割と `retry_after` 解釈の純関数、`/status` の形を検証する。

**未カバー**: 実Discord Gatewayへの接続、実トークン・権限・ネットワーク・本番配送。ローカル代替とのソケット接続はテストするが、実サービスでの疎通は別途確認が必要。テストは実Discordや本番Webhookへ接続しない。

## 制限・注意

- 接続は単一の Durable Object が1本だけ張る（シャーディングなし）。参加サーバーが増えて Discord に要求されたらシャーディング対応が要る。
- Gateway の再開（Resume）で再生された MESSAGE_CREATE は重複しうるが、転送先が `request_id = discord-<message id>` で重複排除するため二重の依頼にはならない（加えて `forward_log` でローカルでも弾く）。
- `/send` はプレーンテキストのみ（埋め込み・添付・スレッド作成は未対応）。

## Hermes Agent（NousResearch/hermes-agent）を参考にした点

Hermes の Discord アダプタ（`plugins/platforms/discord/adapter.py`、discord.py ベース）と比較し、Durable Objectの永続状態とalarmに合うものを取り入れた。

取り入れたもの:

- **2000文字の分割送信**: Hermes は切り捨てず `truncate_message` でチャンク化して順送りし、チャンク数に上限（超過分は通知に置換）を設ける。本実装の `splitDiscordContent`（最大10チャンク、最終チャンクは切り捨て通知、サロゲートペアを割らない）も同じ考え方。
- **429 / `retry_after` の扱い**: Hermes の抽出順（例外の `retry_after` → `Retry-After` ヘッダ → `X-RateLimit-Reset-After`）と短い待機（30秒以下）を`/send`のチャンク再送に適用した。長い429は早期再送しない。outboxは指定時間以降に再試行する（本実装の `parseRetryAfterSeconds`）。
- **「ACK は返るが聞こえない」ソケットの検出**: Hermes は最終 DISPATCH 時刻を監視し、健全に見える死んだ接続を強制再接続する。本実装では `lastDispatchAt` を状態に持ち、4時間（Hermes の既定値）無音なら alarm から Resume 再接続する。
- **Resume 再生の重複排除**: Hermes は再接続後の再生イベント用に dedup キャッシュを持つ。本実装は outbox の主キー＋ `forward_log`（1週間）＋受信側の `request_id` 重複排除の三段で相当する。
- **4014 の案内**: Hermes は privileged intents 不足時に Developer Portal の修正手順を表示する。本実装では close code 4014 のとき `lastError` に同じ案内を残す。
- **新接続前に旧ソケットを閉じる**（二重受信の防止）: 既存実装の `connectLocked` が Hermes と同じ作法だったため、そのまま維持した。

取り入れなかったもの（理由）:

- **discord.py 自体**: Gateway プロトコル（ハートビート／Resume／再接続）は discord.py が担うが、Workers では Python ライブラリは使えず、そもそも仕様が単一ファイル Worker のため、プロトコルは自前の純関数状態機械で実装している。Hermes 側の再接続バックオフも supervisor 前提のため、DO の alarm＋指数バックオフ（上限60秒、fatalは自動再接続停止）に置き換えた。
- **free-response チャンネル**（メンションなしでも応答するチャンネル設定）: 仕様の転送条件は「DM またはメンション」のみで、設定面の追加になるため見送り。
- **不足メッセージの backfill**（再接続後に REST で履歴を取り直す）: Resume 再生と受信側の重複排除で足り、履歴取得 API の権限・流量が増えるため見送り。
- **スレッド／フォーラム／リアクション／音声／スラッシュコマンド**: 仕様外。
- **セッション状態の JSON ファイル永続化**: Hermes は原子的 JSON 書き込みで状態ファイルを持つが、DO では SQLite の単一行状態が同じ役割を果たすため置き換えた。

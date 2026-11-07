# discord-gateway — Discord と Agent 群をつなぐ常駐の耳と口

ユーザーの Agent メッシュ（クロワッサンド／dots など）向けの共有フロントエンド。Cloudflare Worker + Durable Object として実装し、Discord Bot として常時 Gateway に接続して、Bot 宛の発言を dots-events 経由でクロワッサンドへの依頼に変換する。**未デプロイ**（このリポジトリは実装とローカルテストまで）。

- 実装: [worker.js](sandbox://workspace/discord-gateway/worker.js)（単一ファイル、ランタイム依存なし。自動テストのみ `test/` 配下で Miniflare を devDependency として使用）
- 受け渡し先: dots-events の `POST https://dots-events.0g0.xyz/claude-hook`（Standard Webhooks 署名つき。受信側は `request_id` で重複排除する）

## 構成

- Cloudflare Worker `discord-gateway`。HTTP の入口（`/status`、`/connect`、`/send`）だけを担う。
- 永続化と Gateway 接続は **Durable Object（SQLite、クラス `Gateway`、グローバル単一インスタンス）に集約**。接続状態（session_id、resume URL、最終 seq、bot のユーザー ID）と、転送に失敗した依頼の outbox を SQLite に保存する。再デプロイやハイバネーションをまたいでもセッション再開（Resume）ができる。
- Gateway 接続は **WebSocket ハイバネーション**（`ctx.acceptWebSocket()`）で保持する。Hello（op 10）でハートビート間隔を受け取り、DO の alarm でハートビート（op 1）を回す。ACK が返らない接続はゾンビとして切り、Resume（op 6）で再接続する。切断時は close code に応じてセッションを保持／破棄し、バックオフつきで再接続する。alarm は接続の自己復旧（self-start）も兼ねる。
- 生存監視はハートビート ACK だけでなく、**最終 DISPATCH 時刻**も見る。ACK は返るのにイベントが4時間届かない「聞こえないソケット」は強制的に張り直す（Resume するので実害は小さい）。

## 動作

### 入口（Discord → Muse）

- 対象: **DM**、または **Bot がメンションされたギルドメッセージ**。Bot 自身と他の Bot の発言は無視する。
- 転送 body: `{"text", "topic": "discord", "request_id": "discord-<message id>"}`。`text` の1行目は `[discord channel:<channel_id> guild:<guild_id or -> author:<username>]` で、本文から Bot メンションを取り除く。返信先チャンネルはこの行で分かる。
- 署名: Standard Webhooks（`webhook-id` / `webhook-timestamp` / `webhook-signature`、HMAC-SHA256）。dots-kick-events の実装と同一形式。
- 転送失敗は outbox に残し、alarm から最大5回まで再試行する（受信側が `request_id` で重複排除するので再送は安全）。受信側が 429 を返したら `Retry-After` を尊重する。
- 転送済みの `request_id` は `forward_log` に1週間保持し、Resume 再生で同じメッセージが再送されてきたらローカルで弾く（受信側の重複排除と二重化）。

### 出口（Agent → Discord）

- `POST /send`（管理キー認証）に `{"channel_id", "content"}` を送ると、Discord REST `POST /channels/{channel_id}/messages` を Bot トークンで呼ぶ。`content` が Discord の上限（2000文字）を超える場合は切り捨てず、改行・空白の境界で複数メッセージに分割して順に送る（分割数は最大10件、超過分は切り捨て通知に置換）。Discord が 429 を返したら `retry_after`（body → `Retry-After` → `X-RateLimit-Reset-After` の順、上限30秒）だけ待って同じチャンクを再送する（最大3試行）。
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
| `CLAUDE_HOOK_SECRET` | シークレット（要設定） | dots-events の `/claude-hook` と共有する `whsec_` HMAC 秘密 |
| `ADMIN_KEY` | シークレット（要設定） | `POST /connect` と `POST /send` の管理キー |

## デプロイ手順（未実施のスケッチ）

dots-events と同様に gizen（ユーザーの PC）から wrangler で行う想定。

```powershell
cd C:\Users\gizen\workspace\discord-gateway
npx --yes wrangler@4.149.0 secret put DISCORD_BOT_TOKEN
npx --yes wrangler@4.149.0 secret put CLAUDE_HOOK_SECRET
npx --yes wrangler@4.149.0 secret put ADMIN_KEY
npx --yes wrangler@4.149.0 deploy
```

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

Miniflare と純関数の単体テスト（`test/gateway.test.mjs`、29件）。署名形式が dots-kick-events と一致すること、MESSAGE_CREATE のフィルタ（自他の Bot を無視／DM を転送／メンションを転送／通常発言を無視）、Gateway プロトコルの判断（Hello→Identify／Resume、READY のセッション保存、Invalid Session の可否、ハートビート ACK 欠落時の再接続、fatal close code でのセッション破棄、4014 の案内文、DISPATCH 無音時の再接続判断）、`/send` の認証拒否・2000文字超の分割送信・429 リトライ、2000文字分割と `retry_after` 解釈の純関数、`/status` の形を検証する。

**未カバー**: 実 Discord Gateway への接続そのもの（Miniflare では Discord の代替が立てられないため、ソケット実接続はモックしていない）。プロトコル判断は純関数レベルで担保し、実接続はデプロイ後の `/status` と実メッセージで確認する想定。

## 制限・注意

- 接続は単一の Durable Object が1本だけ張る（シャーディングなし）。参加サーバーが増えて Discord に要求されたらシャーディング対応が要る。
- Gateway の再開（Resume）で再生された MESSAGE_CREATE は重複しうるが、転送先が `request_id = discord-<message id>` で重複排除するため二重の依頼にはならない（加えて `forward_log` でローカルでも弾く）。
- `/send` はプレーンテキストのみ（埋め込み・添付・スレッド作成は未対応）。

## Hermes Agent（NousResearch/hermes-agent）を参考にした点

Hermes の Discord アダプタ（`plugins/platforms/discord/adapter.py`、discord.py ベース）と比較し、Durable Object のハイバネーション型に合うものだけを取り入れた。

取り入れたもの:

- **2000文字の分割送信**: Hermes は切り捨てず `truncate_message` でチャンク化して順送りし、チャンク数に上限（超過分は通知に置換）を設ける。本実装の `splitDiscordContent`（最大10チャンク、最終チャンクは切り捨て通知、サロゲートペアを割らない）も同じ考え方。
- **429 / `retry_after` の扱い**: Hermes の抽出順（例外の `retry_after` → `Retry-After` ヘッダ → `X-RateLimit-Reset-After`）と待機上限（30秒）を、`/send` のチャンク再送と outbox 再試行に適用した（本実装の `parseRetryAfterSeconds`）。
- **「ACK は返るが聞こえない」ソケットの検出**: Hermes は最終 DISPATCH 時刻を監視し、健全に見える死んだ接続を強制再接続する。本実装では `lastDispatchAt` を状態に持ち、4時間（Hermes の既定値）無音なら alarm から Resume 再接続する。
- **Resume 再生の重複排除**: Hermes は再接続後の再生イベント用に dedup キャッシュを持つ。本実装は outbox の主キー＋ `forward_log`（1週間）＋受信側の `request_id` 重複排除の三段で相当する。
- **4014 の案内**: Hermes は privileged intents 不足時に Developer Portal の修正手順を表示する。本実装では close code 4014 のとき `lastError` に同じ案内を残す。
- **新接続前に旧ソケットを閉じる**（二重受信の防止）: 既存実装の `connectLocked` が Hermes と同じ作法だったため、そのまま維持した。

取り入れなかったもの（理由）:

- **discord.py 自体**: Gateway プロトコル（ハートビート／Resume／再接続）は discord.py が担うが、Workers では Python ライブラリは使えず、そもそも仕様が単一ファイル Worker のため、プロトコルは自前の純関数状態機械で実装している。Hermes 側の再接続バックオフも supervisor 前提のため、DO の alarm＋指数バックオフ（上限60秒、fatal は5分）に置き換えた。
- **free-response チャンネル**（メンションなしでも応答するチャンネル設定）: 仕様の転送条件は「DM またはメンション」のみで、設定面の追加になるため見送り。
- **不足メッセージの backfill**（再接続後に REST で履歴を取り直す）: Resume 再生と受信側の重複排除で足り、履歴取得 API の権限・流量が増えるため見送り。
- **スレッド／フォーラム／リアクション／音声／スラッシュコマンド**: 仕様外。
- **セッション状態の JSON ファイル永続化**: Hermes は原子的 JSON 書き込みで状態ファイルを持つが、DO では SQLite の単一行状態が同じ役割を果たすため置き換えた。

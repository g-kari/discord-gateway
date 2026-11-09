# discord-gateway — Discord と Agent 群をつなぐ常駐の耳と口

ユーザーの Agent メッシュ（クロワッサンド／dots など）向けの共有フロントエンド。Cloudflare Worker + Durable Object として実装し、Discord Bot として常時 Gateway に接続して、Bot 宛の発言を dots-events 経由で各 Agent への依頼に変換する。このリポジトリの自動テストはローカル代替サービスまでを対象とし、実Discordと本番環境での疎通は別途確認が必要。

- 実装: [worker.js](./worker.js)（単一ファイル、ランタイム依存なし。自動テストのみ `test/` 配下で Miniflare を devDependency として使用）
- ホストする Bot は2つ（**1つの Worker + 1つの Durable Object に相乗り**。DO の常駐コストを2デプロイ分にしないための構成）:
  - **croissand**（クロワッサンドの Bot）: 転送先は dots-events の `POST https://dots-events.0g0.xyz/claude-hook`（Standard Webhooks 署名つき。受信側は `request_id` で重複排除する）
  - **ichihime**（一姫＝dots の Bot）: 転送先は dots-events の `POST https://dots-events.0g0.xyz/trigger`（Bearer 認証、署名なし）
- Bot ごとにトークン・転送先・Gateway 接続・永続状態を分離し、片方の再接続や障害がもう片方に波及しない。一姫側のシークレットが未設定の間、一姫は接続を試みず静かに待機し、croissand は従来どおり動く（有効化手順は後述「一姫の有効化」参照）

## 構成

- Cloudflare Worker `discord-gateway`。HTTP の入口（`/status`、`/connect`、`/send`、`/avatar`）だけを担う。
- 永続化と Gateway 接続は **Durable Object（SQLite、クラス `Gateway`、グローバル単一インスタンス）に集約**。Bot ごとに接続を1本ずつ張り、接続状態（session_id、resume URL、最終 seq、bot のユーザー ID）と、転送に失敗した依頼の outbox を SQLite に保存する（状態は Bot ごとの行、outbox / forward_log は Bot 列つき）。再デプロイやオブジェクト再起動後は永続化した状態でセッション再開（Resume）を試みる。単一 Bot 時代の状態行（kv キー `gateway-state`）と bot 列のないテーブルは、初回読み込み時に croissand のものとしてそのまま引き継ぐ。テーブル再構築は同期トランザクションでまとめ、途中失敗時は両テーブルを元に戻して再試行する（クラス変更・wrangler マイグレーションなし）。
- Gateway 接続は **通常の外向き WebSocket クライアント**（`fetch` Upgrade、`ws.accept()` と標準イベントリスナー）で保持する。Cloudflareの[公式仕様](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)では、外向き接続はハイバネーション非対応。接続中はDurable Objectの実行時間課金が発生する。Hello（op 10）でハートビート間隔を受け取り、DO の alarm でハートビート（op 1）を回す。alarm の起床時刻は **全 Bot のうち最も早い期限**（ハートビート／再接続／outbox 再試行／監視）に合わせる。ACK が返らない接続はゾンビとして切り、Resume（op 6）で再接続する。Hello後の初回ハートビートにはjitterを加える。ハンドシェイク監視はREADY/RESUMEDで解除する。切断時はclose codeに応じてセッションを保持／破棄し、バックオフつきで再接続する。4011を含むfatal codeでは自動再接続を停止し、原因修正後の管理キー付き`POST /connect`で再開する。alarm は接続の自己復旧（self-start）も兼ねる。これらはすべて Bot 単位で独立に判定される。
- 生存監視はハートビート ACK だけでなく、**最終 DISPATCH 時刻**も見る。ACK は返るのにイベントが4時間届かない「聞こえないソケット」は強制的に張り直す（Resume するので実害は小さい）。

## 動作

### 入口（Discord → Agent）

一姫の本人投稿に対するギルド内の反応条件は「Discord のメンションがない」または「一姫自身へのメンション・名前（`一姫` / `風見一姫`）がある」。他エージェントの名前を本文で話題にしただけなら、メンションなしとして対象に含む。他のユーザー・ロール・`@everyone`・`@here` だけへのメンションは対象外。一姫もメンションまたは名前で呼ばれていれば対象に含む。クロワッサンド側の既存条件は変更しない。

メンション判定には Discord の `mentions`・`mention_roles`・`mention_everyone` を優先する。明示的な空配列・`false` は「メンションなし」と扱い、メールアドレスやコードとして書かれたメンション記法だけでは除外しない。各フィールドが欠けた代替イベントに限り、その種類の本文記法を補助判定する。

この条件は本人のギルド投稿に限る。Bot からは受信Bot自身への直接メンションがある場合だけを引き続き転送し、Bot の名前呼びだけ・無宛先投稿や他の人のギルド投稿は新たに許可しない。自分自身の投稿・Webhook投稿は除外し、DM の既存処理も維持する。受信条件への一致は外部操作の許可を意味しない。メンションを除去した後に本文が空になる投稿は、既存どおり転送しない。

- 判定は受信した接続の Bot に対して行う。上記の条件を満たし両方の Bot がメンションされたメッセージは、各 Bot が自分の転送先へ1件ずつ投入する。
- 転送 body: `{"text", "topic": "discord", "request_id": "discord-<message id>"}`。`text` の1行目は `[discord channel:<channel_id> guild:<guild_id or -> author:<username>]` で、本文からその Bot のメンションを取り除く。コードのインデントなど本文内の空白は保持する。返信先チャンネルはこの行で分かる。
- 署名: croissand は Standard Webhooks（`webhook-id` / `webhook-timestamp` / `webhook-signature`、HMAC-SHA256）。dots-kick-events の実装と同一形式。ichihime は署名せず、`Authorization: Bearer <EVENTS_TRIGGER_KEY>` で `/trigger` に送る。
- 転送はまずoutboxに永続化し、alarmからロック外のバックグラウンド配送を開始する。接続時のGateway照会・Upgradeと転送先の応答待ちを共有ロック外で行い、片方が遅くても他方の配送・ACK・heartbeat・status処理を続け、1試行のタイムアウトは10秒。失敗はoutboxに残し、最大5回まで再試行する（受信側が `request_id` で重複排除するので再送は安全）。受信側が 429 を返したら `Retry-After` を尊重する。例外として trigger（ichihime）では、429 以外の 4xx は「依頼自体が拒否された」として再試行せず、その時点で失敗として `forward_log` に記録する（再生で再送されてきても再投入しない）。
- 転送済みの `request_id` は `forward_log` に1週間保持し、Resume 再生で同じメッセージが再送されてきたらローカルで弾く（受信側の重複排除と二重化）。重複排除は Bot 単位（同じメッセージでも Bot ごとに1回は転送する）。

### 出口（Agent → Discord）

- `POST /send`（管理キー認証）に `{"channel_id", "content"}` を送ると、Discord REST `POST /channels/{channel_id}/messages` を Bot トークンで呼ぶ。任意フィールド `"bot": "ichihime"` で一姫の Bot として投稿する（省略時は croissand）。未知の bot 名は 400。`content` が Discord の上限（2000文字）を超える場合は切り捨てず、改行・空白の境界で複数メッセージに分割して順に送る（分割数は最大10件、超過分は切り捨て通知に置換）。Discord が 429 を返したら `retry_after`（body → `Retry-After` → `X-RateLimit-Reset-After` の順）だけ待って同じチャンクを再送する（最大3試行）。待機が30秒を超える場合は早期再送せず429を呼び出し元へ返す。`allowed_mentions.parse`は空にして返信本文による意図しない一斉通知を抑止する。
- 応答: 単一メッセージの場合は Discord の応答ステータスと body をそのまま返す。分割した場合は `{"message_ids": [...], "chunks": n}` を返す。途中のチャンクで失敗したら、送信済み ID と失敗した Discord のステータスを返す。
- `POST /avatar`（管理キー認証）も `"bot"` フィールドで対象 Bot を選べる（既定は croissand）。

### HTTP エンドポイント

| ルート | 認証 | 内容 |
|---|---|---|
| `GET /status` | 公開 | `{"connected": bool, "ready": bool}`（croissand の従来形）に加え、`"bots": {"croissand": {"connected", "ready", "configured"}, "ichihime": {...}}` の Bot 別詳細（ID・秘密情報は出さない） |
| `POST /connect` | 管理キー | Durable Object に（再）接続を促す。任意の `{"bot": "ichihime"}` で対象を1つに絞れる（省略時は全 Bot）。応答は croissand の診断（従来形）＋ Bot 別診断の `"bots"` |
| `POST /send` | 管理キー | 上記の出口。`"bot"` で投稿する Bot を選択 |
| `POST /avatar` | 管理キー | Bot のアバターを変更。`"bot"` で対象を選択 |

管理キーは dots-events の `/trigger` と同じ作法（`Authorization: Bearer <key>` または `X-Trigger-Key` ヘッダ、定数時間比較）。

## 環境変数・シークレット（名前のみ。値はリポジトリに書かない）

| 名前 | 種別 | 用途 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | シークレット（要設定） | croissand の Discord Bot トークン。Gateway の Identify と REST 呼び出しに使う |
| `DISCORD_BOT_TOKEN_ICHICHIME` | シークレット（一姫を使うとき要設定） | 一姫の Discord Bot トークン |
| `CLAUDE_HOOK_SECRET` | シークレット（要設定） | dots-events の `/claude-hook` と共有する `whsec_` HMAC 秘密（croissand の転送用） |
| `EVENTS_TRIGGER_KEY` | シークレット（一姫を使うとき要設定） | dots-events の `/trigger` 用 Bearer キー（一姫の転送用） |
| `ADMIN_KEY` | シークレット（要設定） | `POST /connect`・`POST /send`・`POST /avatar` の管理キー |
| `FORWARD_MODE` | 変数（旧互換） | 転送モードは Bot ごとの固定設定になったため、現行デプロイでは使わない（attemptForward に Bot を渡さない場合のフォールバックとしてのみ残置） |

## 一姫の有効化

一姫（dots の Bot）は同じデプロイに相乗りする。別 Worker は立てない。有効化は、同じ Worker に次の2つのシークレットを設定するだけ:

- `DISCORD_BOT_TOKEN_ICHICHIME`: 一姫の Bot のトークン（ユーザー本人が wrangler で登録する）
- `EVENTS_TRIGGER_KEY`: dots-events の `/trigger` 用キー

設定が揃うまで一姫は「未構成」として接続・転送を一切試みず、`/status` の `bots.ichihime.configured` は `false` のまま。設定後は `POST /connect`（任意で `{"bot": "ichihime"}`）で接続を促せる。一姫宛のメンション／DM は `/trigger` 経由で「dots への依頼」として投入され（`/claude-hook` とその秘密はクロワッサンド側専用なので一姫の転送には使わない）、返信は `POST /send` に `{"bot": "ichihime", ...}` を指定して一姫の Bot として投稿する。転送 body は croissand と同一形式。

## デプロイ手順（参照）

dots-events と同様に gizen（ユーザーの PC）から wrangler で行う想定。

```powershell
cd C:\Users\gizen\workspace\discord-gateway
npx --yes wrangler@4.149.0 secret put DISCORD_BOT_TOKEN
npx --yes wrangler@4.149.0 secret put CLAUDE_HOOK_SECRET
npx --yes wrangler@4.149.0 secret put ADMIN_KEY
npx --yes wrangler@4.149.0 deploy
```

（一姫を有効化するときは、同じ Worker に `wrangler secret put DISCORD_BOT_TOKEN_ICHICHIME` と `wrangler secret put EVENTS_TRIGGER_KEY` を追加する。別 Worker はデプロイしない。）

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

複数のworkerd試験環境が短い監視期限を奪い合わないよう、`npm test` はファイル単位で直列実行する（各試験内の複数ソケット・並行I/Oは実際に同時実行する）。Miniflareと純関数の単体テスト（`test/gateway.test.mjs`）に加え、`test/lifecycle.test.mjs`では固定依存版workerd内のローカルDiscord代替と実際のWebSocketを使い、Hello→Identify→READY、Resume、fatal停止、遅いWebhook配送中のheartbeat/ACK/statusと重複排除を検証する。`test/forward-mode.test.mjs`では `FORWARD_MODE` の振り分け（既定=署名つき `/claude-hook`、trigger=Bearer で `/trigger`・署名ヘッダなし）と、trigger モードの再試行分類（429以外の4xxは終了、5xxは再試行）を検証する。`test/multi-bot-lifecycle.test.mjs`では同じDO内の2本の実WebSocketで、Bot別のIdentify/READY・転送・重複排除・片方のUpgrade停止中の他方のheartbeat/ACK・fatal停止の分離を検証する。`test/multi-bot.test.mjs`では2 Bot 相乗り（Bot ごとの転送・状態分離・状態移行・未構成 Bot の静穏・`/send` の bot 選択・`/status` の bots 詳細・alarm の最早期限・SQLite の bot 列移行と途中失敗後のrollback/再試行、未設定Botの滞留行による配送の妨害防止、リプレイ時の再試行期限維持）を検証する。署名形式が dots-kick-events と一致すること、MESSAGE_CREATE のフィルタ（自他の Bot を無視／DM を転送／メンションを転送／通常発言を無視）、Gateway プロトコルの判断（Hello→Identify／Resume、READY のセッション保存、Invalid Session の可否、ハートビート ACK 欠落時の再接続、fatal close code でのセッション破棄、4014 の案内文、DISPATCH 無音時の再接続判断）、`/send` の認証拒否・2000文字超の分割送信・429 リトライ、2000文字分割と `retry_after` 解釈の純関数、`/status` の形を検証する。

**未カバー**: 実Discord Gatewayへの接続、実トークン・権限・ネットワーク・本番配送。ローカル代替とのソケット接続はテストするが、実サービスでの疎通は別途確認が必要。テストは実Discordや本番Webhookへ接続しない。

## 制限・注意

- 接続は単一の Durable Object が Bot ごとに1本ずつ張る（シャーディングなし）。参加サーバーが増えて Discord に要求されたらシャーディング対応が要る。
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

# 一姫 Discord返信コネクタ

本人専用の認証付きMCPコネクタのソースです。既存 `g-kari/discord-gateway` の `POST /send` に、一姫固定で1通だけ渡します。既存Gateway、Botトークン、接続、権限、デプロイには変更を加えません。

**この成果物は未配備です。インストール済みコネクタや実送信完了を意味しません。** `SEND_ENABLED=false`、送り先空、認証subject空、公開ルートなしで出荷します。

## 構成

MCPクライアント → OAuth認証付き返信Worker → 永続ReplyLedger → private Service Binding → 既存Gateway `/send` → Discord

- OAuthResourceServerがトークンのresource/audience、有効期限、検証失敗を処理します。本人subjectを完全一致で照合し、read/send scopeを各ツールで確認します。
- 実ユーザーの本人確認とOAuth同意は、別途承認済みの認可サーバーが担当します。固定ユーザーを無認証で返す本番サーバーは含めません。合成試験の認証fixtureを本番に使わないでください。
- Botは常に `ichihime`。クライアントはBot名・管理キー・送信URLを指定できません。
- 送り先はサーバー設定の正確なguild/channel組だけです。DM、スレッド、任意URL、メンション、添付は受け付けません。許可リストのchannel typeは0（テキスト）/5（告知）に限定します。実メタデータの確認は有効化前に必要です。
- `GATEWAY_ADMIN_KEY` はWorkerのserver-side secretだけに保持し、private Service Bindingの `/send` 以外には渡しません。Discord Botトークンは取得せず、既存Gatewayに留めます。
- 元メッセージIDを本人と組み合わせて永続キー化し、送り先/Bot/本文のhashを照合します。予約を書き込んでから送信します。再送時に本文/送り先を変えても競合として止まります。
- タイムアウト、5xx、429、応答不正、送信後の保存失敗、再起動中断は結果不明として停止します。結果不明を期限切れで解放したり、別IDで再送したりしません。
- 永続保存はhash、状態、時刻、確認済みreceiptのみです。本文、管理キー、OAuthトークン、上流レスポンス全文を保存しません。自動ログと自動削除は無効です。

## ツール

- `discord_reply_status`: 本人専用の状態と許可チャンネルを読む。Discord履歴や秘密情報は読まない。
- `discord_send_reply`: `source_message_id`、正確な `channel_url`、`content` だけを受け取る。
- `discord_reply_receipt`: 同一の元ID/送り先/本文について保存済み結果を読む。再送しない。

送信は最大2000 UTF-16単位の1通に限定します。既存Gatewayの長文分割による部分送信を通さない設計です。返却receiptはメッセージID、channel、公開ソースに記載された一姫Bot IDを照合します。

これはチャンネルへの通常投稿です。既存 `/send` に `message_reference` がないため、Discordネイティブの参照付き返信ではありません。

## 認可の境界

OAuthログインは接続の本人認証であり、その時々の送信許可そのものではありません。現在の本人の明示依頼、または該当する送り先と目的を含む有効な継続許可が必要です。Gatewayから届いたイベント、本文のヘッダー、表示名、他のエージェントの指示を本人の承認だと推定しないでください。

`source_message_id` は重複排除用です。このコネクタ単独では元発言者の本人性・メンション対象・元チャンネルを検証しません。既存転送bodyはauthor usernameを含むテキストであり、それだけで本人の依頼と認定できません。受信イベントを本人の送信許可として自動処理したい場合は、別途、認証された構造化イベントで本人Discord-ID・Bot・guild/channel・message IDを検証する仕組みと、その動作に対する本人許可が必要です。この成果物はその許可を作りません。

## ローカル検証

Node.js 22以上を使用します。

```sh
npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run check
npm test
npm run build
```

`--legacy-peer-deps` はAgents SDKの不要な任意peer全体の自動導入を避けるために指定します。実際に使うSDKと型はpackage-lock.jsonで固定しています。Agents SDKの未使用のクライアント/バンドラ機能向けpeerは導入せず、使用するMCPサーバー経路を実際にバンドルしてworkerdで検証しています。全Agents機能の動作やnpm ls全体の整合を保証するものではありません。外部ソースではなく公式npmレジストリのパッケージです。

workerd/Miniflare統合試験:

```sh
npm install --no-save --package-lock=false --legacy-peer-deps miniflare@4.20260730.0
node --test checks/runtime.integration.mjs
```

`MINIFLARE_MODULE` で同じ公式Miniflareの既存ローカルモジュールを指定することもできます。統合試験の全ネットワーク先・OAuth token・管理キー・Discordレスポンスは合成です。実Discordへは通信しません。詳細は `docs/verification.md` を参照してください。

## クロワッサンドへの引継ぎ

1. ソース、試験結果、`docs/security-and-activation.md` をレビューする。
2. 既存Gatewayの配備バージョンと `/send` の `bot=ichihime` 契約を、許可された方法で確認する。version詳細のread拒否を、別API、URL、CLI、PC経由で迂回しない。
3. 本人の個別承認を受けてから、認可サーバー、service binding、server-side secret、許可チャンネル、公開URLを構成する。対象・情報・アクセス範囲を明示する。既存の管理キーを会話や成果物に貼らない。
4. `SEND_ENABLED=false` のまま認証なし/別subjectの拒否、本人によるinitialize/tools/list/statusを確認する。
5. 本人が指定した送り先と本文で1回だけ送信テストの許可を取り、送信とreceipt/重複試験を実施する。結果不明は再送せず照合する。
6. 実在するHTTPS `/mcp` URLと正規MCP discoveryを確認した後だけ、`tools/package-plugin.mjs` で、実際に検証したOAuthクライアント方式（CIMD/DCR）を指定して接続パッケージを作る。未確認URLの仮コネクタは作成しない。

共有・デプロイ・認証を自動実行するスクリプト、定期送信、Gateway再接続、avatar変更は含めていません。

## GitHubでの配布

このディレクトリは独立した返信コネクタだけを格納します。既存Gatewayの実装・設定は変更しません。根のnode --testが子ディレクトリの試験を自動実行しないよう、試験をchecks/へ分離しています。

レビュー済みの元配布ZIPは [artifacts/ichihime-discord-reply-connector-source-20261107.zip](artifacts/ichihime-discord-reply-connector-source-20261107.zip) です。SHA-256: 55d27a6f86979273423fc098844b23434a1ce7ad785ec3d2a226528c55cf6184。元ZIP内は単体プロジェクト用のtest/配置で、GitHubの展開ソースでは同じ試験をchecks/へ移しています。製品srcの内容は同一です。

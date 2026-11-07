# 独立セキュリティレビュー

## 判定

レビューした未配備候補のコードと合成検証の範囲では、修正後に未解消の重大・高リスクの問題は確認しませんでした。本番配備、OAuth接続、継続アクセス追加、実送信を承認するものではありません。

## 評価範囲

- `src/core.mjs`、`src/worker.mjs`、`src/ledger.mjs`、MCPパッケージ生成処理、設定例、ドキュメントと試験を確認しました。
- OAuth Resource ServerとMCP SDKの、実際に固定された依存パッケージの実装・同梱文書も照合しました。
- 実キー、Botトークン、ユーザー端末、本番OAuth、本番Discord、Gateway本体への操作は行っていません。すべての実行は合成Auth/Gatewayを使い、外部ネットワークを遮断しました。

## 指摘と修正確認

1. SDKのhostname単位Origin検査はschemeとportを区別しないため、Worker外側に正確なOrigin比較が追加されました。OAuth SDKが外側で再付与するCORSヘッダーも除去されます。
2. OAuth SDKは期限省略を許容するため、有限の未来期限、非空のuserId/clientIdを必須にするvalidatorラッパーが追加されました。本人subjectとread/send scopeは別途厳密に照合されます。
3. 数値型のDiscord message IDがJavaScriptの整数精度で丸められたまま確認済みreceiptになる不具合を合成応答で再現しました。修正版はstring型を必須にし、不正応答はunknownになります。
4. MCPの旧protocol拒否を合成workerdで再現しました。修正版は認証・Host/Origin検査を保ったままstateless互換経路を許可します。
5. Workersで利用できるredirect方式へ修正されました。`manual`によりリダイレクトへ管理キーを追従送信せず、200/201以外はunknownになります。

## 独立した合成監査

合成Auth/Gateway、実workerd、実SQLite Durable Objectを使う32チェックが通過しました。

- tokenなし、不正token、期限欠落/NaN/期限切れ、userId/clientId欠落、propsによる本人偽装、scopeの不正型/欠落、write-only、別本人、別audience、認証サービス例外を拒否。
- 異なるOriginのscheme/port/path/host、opaque origin、localhost originを拒否。異なるHost、resource origin、HTTP resourceを拒否。
- 本人の非ブラウザー接続と正確な同一Originでのtool discoveryが成功。CORSヘッダーと秘密情報を返さない。
- read-only tokenによる送信を拒否。
- 上流500と数値receiptをunknownとして保持。同じsourceの内容/送り先変更を拒否。
- 同一sourceの並列要求はGateway呼び出し1回に限定。
- 完全なランタイム停止・再起動後もunknownとsentの両方が維持され、Gateway呼び出しは0回。

最終候補で構文検査、unit34件、runtime統合10件、追加監査32チェックを独立再実行し、すべて通過しました。Node test runnerではruntime10件と追加監査script1件の合計11件として集計されます。

依存監査で検出されたzodのHigh advisoryは4.6.7への更新で修正されています。更新後の固定lockとインストール済み版を照合し、同梱の`dependency-audit.json`ではinfo/low/moderate/high/criticalの全件数が0であることを確認しました。これは監査実行時の既知advisoryに対する結果であり、将来の安全性を保証するものではありません。

レビューした最終bundleのSHA-256は`62e1f1a45d4a7f8a6b08541fe5ec99ced1738f73b5b6b39564cce464ac77db1e`です。

レビューした製品ソースのSHA-256:

- `src/core.mjs`: `5cd52c7b89802b495a384478e974f0b12abe9460606abee1a4f584e59cc93b36`
- `src/ledger.mjs`: `62595c21d5ea69d91473aa9a430d1a9299b64dd9d1d23c587f7d3e549159ba8b`
- `src/worker.mjs`: `7463f13d6ab8e6b14427e48951184b800e4068562a32dade5d398500141cd5f8`

## 本番有効化前に残る確認

- 本人だけを認証する実認可サーバー、正確なresource/audience、発行scope、安定した本人subject、実HTTPS MCP URL、実クライアントのdiscoveryを検証する必要があります。
- private Service Bindingと既存管理キーの新Workerへの配置は継続アクセスの追加です。対象と影響を明示した個別承認が必要です。既存キーの権限自体はこのコネクタでは縮小されません。
- allowlistのguild/channel/typeは静的な設定です。本人が許可した対象を正規Discordメタデータで照合し、実Gatewayの配備版と固定Botの契約を確認するまで送信を有効にしないでください。
- OAuth本人認証と、その都度の送信許可は別です。`source_message_id`は重複排除に使うだけで元発言者の本人性を検証しません。受信イベントや表示名だけを本人の指示とみなせません。
- 保証するのはat-most-onceの送信試行です。予約後のクラッシュでは欠送になり得ます。結果不明の予約を消したり別source IDで再送したりせず、許可された方法で照合する必要があります。
- 最初の実送信は、送り先と本文を含む本人の明示許可を得て1回だけ実施してください。

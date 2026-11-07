# 公開前の確認

既存公開リポジトリへの本人の保存依頼に対応するソース配布です。リポジトリの公開範囲や既存Gatewayの実装・設定は変更しません。

- 新規ソース、固定依存、合成試験、独立レビュー、合成試験結果、再現用配布ZIPのみを含みます。
- .env、.dev.vars、node_modules、本番設定、実秘密、実OAuth token、Bot token、実本人subjectは含めません。送り先設定と送信は空/無効のままです。
- 試験の認証値とguild/channel/message IDはsynthetic fixtureです。一姫Bot IDは既存の公開Gatewayソースと照合した値です。
- token/private-key/JWT形式の静的検査とZIP展開内容の同じ検査を行い、該当なしを確認しました。この検査だけで全種類の秘密を自動検出できるとは主張しません。
- GitHubの展開ソースでは試験をchecks/に配置し、既存Gatewayの根のtest自動検出を避けています。製品srcのSHA-256は独立レビュー済み候補と同一です。
- 新しいCIはread-only checkoutと合成試験のみです。配備、secret、外部通信の有効化、公開権限変更は行いません。

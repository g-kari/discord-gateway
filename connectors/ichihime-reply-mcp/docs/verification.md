# 検証記録

2026-11-07。実装は隔離したクラウド作業領域だけで行い、既存Gatewayのコード・配備・secret・ユーザーPCには変更を加えていない。

## 最終候補の確認

- Node.js 24.19.0。
- `npm run check`: 成功。製品4ファイルとパッケージ生成ツールのsyntax確認。
- `npm test`: コア34件とJWT adapter51件・独立追加34件、成功119、失敗0、skip0。
- `npm run build`: 成功。公式OAuth Provider/Agents SDK/MCP SDKを含むWorkerバンドルを作成。
- workerd/Miniflare 4.20260730.0統合: RPC経路10件とJWT本番mode5件・独立追加統合3件が全成功（独立監査fileと合わせNode集計19件）。実SQLiteへ保存し、ランタイム全再起動後も再送しないことを確認。
- 別実装担当による独立合成境界監査: 32チェック全成功。可搬テストを同梱し、取り込み後も再実行成功。
- `npm audit --omit=dev`: 最初にZodのHigh GHSA-mrhx-c7xc-m3w5を検出した。修正版4.6.7へ更新し、最終監査のprod既知脆弱性は0。修正後に上記syntax・unit・build・workerd・独立監査を再実行した。

証拠: `check-results.txt`、`build-results.txt`、`test-results.tap`、`runtime-results.tap`、`independent-results.tap`、`dependency-audit.json`。

## 実行した境界

無認証、他subject、他audience、期限切れ/期限欠落、client ID欠落、scope不足/不正、propsによる本人偽装は拒否する。Originはscheme/portを含む完全一致、Hostも許可先だけに限定し、SDKが付ける外側CORSヘッダーを除去する。

MCPは2025-06-18のinitializeと既存形式、2026-07-28の必須メタデータ/ヘッダーを伴うstateless要求の両方を試験した。実ChatGPTクライアントでのOAuth同意・接続・discoveryは未検証。

送り先/Bot/秘密情報を入力に追加する要求、別送り先、メンション、過長本文を拒否する。上流はprivate `/send`、固定Bot/サーバー側キーだけで呼び出す。並列実行、保存前/保存後の失敗、network/429/5xx、数値message ID/不正応答、プロセス全再起動でも同じ元メッセージを再送しない。成功receiptだけからID/channel/authorを確認し、本文やsecretを永続化しない。

MiniflareのローカルHTTPプロキシはHostを127.0.0.1に置き換えるため、合成ingress Workerが正規URLからHostを設定してprivate Service Bindingで製品Workerへ渡す。これは試験fixtureだけの処理であり、製品のHost検証を無効化するものではない。

## 未実施

新Worker配備、公開ルート作成、認可サーバー作成/変更、OAuth grant、Service Binding/credentialの作成追加、server-side secret設定、実Discord送信、Bot/チャンネルの実権限照合は未実施。これらが成功したとは記録しない。

既存Gateway version詳細のread拒否を別経路で迂回していない。公開ソースの `/send` 契約を使用した合成試験であり、本番配備版の一致は別確認が必要。

## v0.2.0 JWT adapter追加検証

実ES256署名を使い、issuer/audience/単一aud、期限/iat/nbf、raw subject、cid、jti、scope型/重複、ID token/BFF shape、署名不正/HS256、jku/inline key拒否、kid rotation、concurrent初回fetch、取得間隔、失敗/期限切れcache、redirect/不正/過大/秘密鍵入りJWKSを合成検証した。全JWTと署名鍵はfixtureで、本人tokenを取得していない。実workerdは固定IdP URLに対する合成JWKS応答以外の外部通信を禁止し、AUTH_SERVER bindingなしで本番modeの拒否と1回送信/重複排除を確認した。

公開IdP metadata/JWKSと既存dots-events protected resource metadataはread-only GETで200を確認した。ただし本番token発行とChatGPT接続は未検証。本人subjectと既存resourceの私的設定は未確認である。本人が許可した認証済み手順で照合するまで未設定のままにする。

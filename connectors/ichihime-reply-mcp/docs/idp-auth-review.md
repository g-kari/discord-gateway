# v0.2.0 0g0-id JWT adapter 独立レビュー

2026-11-07。対象は一姫本人専用 Discord 返信 MCP の `src/idp-auth.mjs` と `src/worker.mjs` の認証統合、依存関係、配備設定、関連ドキュメント。候補のコード・設定は変更せず、追加試験と再バンドルは別の一時領域で実施した。

## 結論

**レビューした境界と合成試験では、認証迂回、別 subject による送信、外部鍵の注入、失敗時の認証許可に至る新しい問題は見つからなかった。ソース公開を止めるセキュリティ所見はない。** これは本番配備、継続アクセス追加、本人 subject の確定、実 OAuth 接続、Discord 送信の承認・成功を意味しない。

### 残る互換性条件

protected-resource discovery と通常の challenge は `discord:reply:read` だけを広告する。read-only token による send は拒否され、MCP の HTTP 200 内で `insufficient_scope` を返すため、汎用クライアント向けの HTTP OAuth scope-upgrade challenge はない。

意図した生成 plugin は `defaultScopes` に read と send の両方を指定する。この設定を実 ChatGPT クライアントが採用すること、0g0-id の DCR/認可が resource scope を受け付けることは未検証。これは権限昇格ではなく接続・送信可用性の条件であり、一般的な discovery だけで send scope を取得できるとは説明しない。使用 SDK は `requiredScopes` と `resourceMetadata.scopes_supported` の併記を拒否するため、単純な設定追加で修正した扱いにしない。

## 検証できた境界

- 固定 issuer と固定 HTTPS JWKS、ES256/P-256 のみ。JWT 内の `jku`、`x5u`、`jwk`、`x5c` を拒否し、Bearer を JWKS fetch へ転送しない。
- 正しい署名に加えて完全一致する単一文字列 audience、必須 sub/cid/scope/jti、有限 exp/iat、未来 iat の拒否、有効期限と最大 900 秒の寿命を確認する。署名済み JSON の数値オーバーフローも拒否した。
- 署名検証後の raw subject を設定済み owner と完全一致で比較する。TOFU、props、tool 引数、Discord ID による owner 採用はない。read-only token から send はできない。
- 公開鍵は最大 5 分 cache。unknown kid の再取得は 30 秒間隔に制限し、初回・鍵変更時の並列 fetch を共有する。期限切れ cache の更新失敗は認証拒否、cooldown 後は正常回復した。
- JWKS の redirect、16 KiB 超過、過大な Content-Length、UTF-8 不正、鍵数超過、重複 kid、秘密鍵混入、不正 key operation/EC point は拒否する。ストリーム超過時の cancel を確認した。
- 3 秒 timeout は fetch の応答ヘッダー待ちと本文読み取りの両方を覆う。Node の signal fixture と実 workerd の合成遅延応答で、認証拒否と追加 fetch の抑止を確認した。
- コネクタ製品コードに token/claim のログ・永続化はない。SDK は処理中の認証コンテキストに token を保持するが、ledger への入力は userId/scope のみである。
- 本番 JWT mode は `AUTH_SERVER` binding なしで動作する。不明 mode、欠落 binding を伴う RPC mode、JWT mode の issuer 設定不一致は閉じたまま停止する。

## 独立再実行

Node.js 24.19.0、jose 6.2.15、Miniflare 4.20260730.0。配備や実 Discord 通信は実施していない。統合試験の IdP と Gateway は合成で、許可した fixture 以外の外部通信を無効にした。

- `npm run check`: 成功。
- 配布済み unit tests: **85 / 85 成功**、失敗・skip 0。
- `npm run build` と同じ esbuild flags、出力先だけ一時領域へ変更: 成功。
- `runtime.integration.mjs`、`independent-audit.integration.mjs`、`idp-jwt.integration.mjs`: **16 / 16 成功**。この中に独立境界監査 32 checks を含む。
- 新規 `idp-auth-independent.test.mjs`: **34 / 34 成功**。claim/header/key/size/UTF-8/cache/並列更新/timeout を追加検証。
- 新規 JWT integration 3 件: **3 / 3 成功**。実 workerd の遅いヘッダー、遅い本文、scope discovery/read-only send 拒否を追加検証。

追加試験数は既存 85/16 件とは分けて記載した。候補ファイルの SHA-256 を再照合し、監査による変更がないことを確認した。依存監査については提供された production audit の既知脆弱性 0 の記録を確認したが、この監査では registry への audit を独立再実行していない。

## 配備前の未解決条件

1. 本人の raw `user.id` と実 resource URL を、許可された認証済み手順で照合する。未確認値、pairwise ID token の sub、Discord ID、最初に届いた JWT を採用しない。
2. 本人限定 resource の登録、Gateway private binding、server-side secret、継続アクセスの追加は対象を確定し必要な操作時承認を得る。`allowed_subjects=[]` は全利用者許可なので使わない。
3. 実 ChatGPT の DCR payload、resource scope の同意/発行、read+send 取得、本人/他 subject の拒否を、まず送信無効で確認する。
4. JWT mode はオンライン失効確認ではない。既発行 token の失効反映に最大 15 分、鍵更新に cache 最大 5 分という制約を保持する。緊急停止は返信 Worker の送信無効化等で行う。
5. 本番 Gateway 契約、実チャンネル種別と Bot 権限は未検証。private owner/resource read と Gateway version 詳細の既存拒否を再試行・迂回していない。実送信は正確な送り先・本文の別承認と検証が必要。

## 公開 IdP 契約の独立照合

固定 ref `efbcc79895b6081028b7483402f489d3fb0c78ff` の次の公開ソースを read-only 取得して確認した。

- [token-pair.ts](https://github.com/g-kari/0g0-id/blob/efbcc79895b6081028b7483402f489d3fb0c78ff/workers/id/src/utils/token-pair.ts): resource access token は raw `user.id` を sub、resource を aud、client ID を cid として発行する。ID token は pairwise subject を使用する。
- [jwt.ts](https://github.com/g-kari/0g0-id/blob/efbcc79895b6081028b7483402f489d3fb0c78ff/packages/shared/src/lib/jwt.ts): access token は ES256+kid、iat、15 分 exp、jti を持つ。ID token は cid/scope を持たない。公開 JWKS の alg/use/kid/curve 形式は adapter の要件と整合する。

## レビュー対象 SHA-256

```
5cd52c7b89802b495a384478e974f0b12abe9460606abee1a4f584e59cc93b36  src/core.mjs
b7e246800e5e117540d710523a821c6014884b5b5074e1a88ebdbbf4fbea062f  src/idp-auth.mjs
62595c21d5ea69d91473aa9a430d1a9299b64dd9d1d23c587f7d3e549159ba8b  src/ledger.mjs
59e517e8244824894ea3f479178dee907de5c375e64814fe4183d5636b7e0c2d  src/worker.mjs
e1bb4d5738ad8f5f4ce27d9d9d2fc8fb84fad66291b5cb0f55e8ef7827a92a13  package.json
c0b3fd207c919319152e7a4fd4ab918b8cdc0e606c303d2dbbfb1859ff37510a  package-lock.json
a586fb2aeaa7d428528f621d7e45f63f93033dd2f9ca2be8d1a8964bebe83502  wrangler.example.jsonc
```

## 取り込み後の追加確認

作成担当が独立追加試験を取り込み、unit 119/119、直列workerd統合19/19（独立境界32チェックを含む）を再実行して成功した。並列実行時に負荷依存の4.2秒の壁時計上限assertionだけが失敗したため、レビュー担当の確認の上、その上限assertionを削除した。4.5秒後に正しいJWKSを返すfixtureでの認証拒否と取得抑止は維持し、製品コードは変更していない。timeoutは中断動作を検証するもので、HTTP応答全体が常に3秒以内となる保証ではない。CIも統合試験を直列実行する。

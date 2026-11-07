# 0g0-id resource access token契約

v0.2.0は既存IdPを変更せず、返信Worker内の `src/idp-auth.mjs` でresource access tokenを検証する。認可サーバーを新作したり、既存0g0-idへ存在しないRPCを要求したりしない。

## 署名とclaim

公開ソースの固定ref `efbcc79895b6081028b7483402f489d3fb0c78ff` を根拠にする。

- `workers/id/src/utils/token-pair.ts` のresource発行は `iss=IDP_ORIGIN`、`sub=user.id`、`aud=resource`、`cid=client_id`、resourceで許されたscopeを署名する。
- `packages/shared/src/lib/jwt.ts` はheaderをES256+kid、issued-atを現在時刻、expiryを15分、jtiをUUIDにする。ID tokenはpairwise subject・client audienceを使い、cid/scopeを持たない。
- adapterは固定issuer `https://id.0g0.xyz`、固定JWKS `https://id.0g0.xyz/.well-known/jwks.json` だけを使う。token内のjku/x5u/inline jwk/x5cを拒否する。
- joseの署名/issuer/audience/時刻検証後、単一の完全一致audience、有限iat/exp、未来iat拒否、最大900秒の寿命、非空のsub/cid/jti、空要素や重複のないscope文字列を必須にする。
- 認証結果はaudience/expiresAt/userId/clientId/scopeと空propsだけ。OAuth token、個人プロフィール、署名鍵を永続化・ログしない。

## 公開鍵の取得

固定HTTPS先へBearerなしで取得する。redirectを辿らず、3秒のtimeout、16KiBの応答上限、最大8個のpublic P-256 ES256署名鍵、kidの一意性を要求する。秘密鍵dや不適切なkey operationを拒否する。

公開鍵だけをisolate内で最大5分cacheする。初回並列fetchを共有し、unknown kidの再取得には30秒の間隔を設ける。失敗、期限切れcache、署名不正を未検証decodeや固定ownerで代用しない。失敗時はトークンを拒否する。

## 本人と権限の設定

`OWNER_SUBJECT` はこのresource tokenのraw `sub=user.id`。Discord ID、pairwise ID token、他サービスのowner-sub APIの値は使わない。本人アカウントとの対応を許可された認証済みreadで確認する。TOFUで最初のtokenをownerに設定しない。

IdPへresource URIと `discord:reply:read` / `discord:reply:send` を登録し、allowed_subjectsを本人1人だけに絞る必要がある。これは継続アクセスの追加なので、具体的対象を説明した操作時承認後にだけ行う。空allowed_subjectsはIdPでは全員許可となるため使わない。

このJWT検証はオンラインintrospectionではない。ユーザー/refresh grant/resourceの失効やscope削減を既発行JWTへ即時反映するとは保証しない。最大15分の有効期限、公開鍵cache最大5分の制約がある。即時停止が必要なら返信Workerの送信を無効化する。オンライン失効確認を追加するための新credentialはこの成果物に含めない。

## 接続の順番

1. 本人subject、正確なMCP HTTPS URL、許可Discord channel URLとtypeを確認する。
2. 本人の操作時承認後、IdP resource登録、Gateway private binding、server-side secretを作成し、送信無効でWorkerを配備する。
3. 無認証/他subject/別audienceを拒否し、本人の実OAuth同意とread-only discovery/statusを確認する。
4. 本人が指定した正確な送り先と本文の1通を許可した後、送信を有効化してreceiptと重複排除を確認する。

実ChatGPT DCR、scope解決、本人認証、Botのチャンネル権限、本番Gateway契約は未検証。既存進捗pluginの別Botや別の用途で結ばれたDiscord IDをこの接続の証拠として流用しない。

## DCR互換性の未確認点

現0g0-idの `/api/register` はpublic client (`token_endpoint_auth_method=none`) とPKCEを前提にする一方、DCR本文のscopeはOIDCの列挙に限定している。返信scopeをDCR本文へ送るclientは `invalid_client_metadata` になる。resource付き認可/token発行はresource登録のallowed_scopesを使用するが、実ChatGPT clientの登録payloadは未確認である。既存IdP設定や登録制限を勝手に広げず、実接続時の正規エラーで切り分ける。resource用scopeのDCR制限を調整するなら別途レビュー・本番操作承認が必要。

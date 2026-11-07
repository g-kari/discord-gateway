# 確認した公開資料

- 既存Gatewayのmulti-Bot契約と固定一姫Bot ID: https://github.com/g-kari/discord-gateway/pull/4
- 対応するmerge: https://github.com/g-kari/discord-gateway/commit/9c135f84c2fdfabc09915583e59a6936899babfd
- 公式Remote MCP: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- 公式OAuth認可/resource server: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- 公式MCP transport: https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- Durable Object永続ストレージ: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Durable Object transactionと並列処理: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- 実装APIは公式npmの `agents@0.33.0`、`@modelcontextprotocol/server@2.4.0`、`@cloudflare/workers-oauth-provider@1.2.4`、`zod@4.6.7` の公開パッケージと同梱文書を照合した。

本番のWorker version詳細、secret値、ユーザーPC、既存の認証トークンは取得していない。

## 0g0-id adapterの固定契約

- resource access tokenのraw sub/aud/cid: https://github.com/g-kari/0g0-id/blob/efbcc79895b6081028b7483402f489d3fb0c78ff/workers/id/src/utils/token-pair.ts
- 署名header/15分期限/ID tokenとの差: https://github.com/g-kari/0g0-id/blob/efbcc79895b6081028b7483402f489d3fb0c78ff/packages/shared/src/lib/jwt.ts
- 本人限定resource登録API: https://github.com/g-kari/0g0-id/blob/efbcc79895b6081028b7483402f489d3fb0c78ff/workers/id/src/routes/resources.ts
- 公開issuer/DCR/PKCE metadata: https://id.0g0.xyz/.well-known/oauth-authorization-server
- 公開JWKS: https://id.0g0.xyz/.well-known/jwks.json

joseは公式npmの6.2.15に固定した。公開鍵、metadataの確認は本番の認証/送信成功を意味しない。

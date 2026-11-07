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

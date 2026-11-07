import { OAuthResourceServer } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { READ_SCOPE, WRITE_SCOPE, toolError, toolResult } from './core.mjs';
import { connectionPolicies, resolveConnection, connectionLedgerName } from './connection-policy.mjs';
import { IDP_ISSUER, validateIdpToken } from './idp-auth.mjs';
export { SharedReplyLedger as ReplyLedger } from './shared-ledger.mjs';
const replySchema = z.strictObject({ source_message_id: z.string().regex(/^[1-9][0-9]{16,19}$/), channel_url: z.string().max(120), content: z.string().min(1).max(2000) });
function createServer(env, auth) {
  const server = new McpServer({ name: 'shared-discord-reply', version: '0.3.0' });
  server.registerTool('discord_reply_status', {
    description: 'Read only this authenticated OAuth client connection, its server-fixed Bot and allowed channels. Other connections and secrets are never listed.',
    inputSchema: z.strictObject({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => {
    try {
      const row = resolveConnection(auth, env);
      return toolResult({ connection_id: row.connection_id, bot: row.bot, send_enabled: env.SEND_ENABLED === 'true' && row.enabled, allowed_channels: row.targets.map(t => `https://discord.com/channels/${t.guild_id}/${t.channel_id}`), source_identity_verified: false });
    } catch (e) { return toolError(e); }
  });
  for (const [name, operation, scope] of [['discord_send_reply', 'send', WRITE_SCOPE], ['discord_reply_receipt', 'receipt', READ_SCOPE]]) {
    server.registerTool(name, {
      description: operation === 'send' ? 'Send one explicitly owner-authorized routine low-impact reply through this OAuth client connection only. Bot and targets are fixed by server policy, never by the caller. Owner instruction or applicable standing approval is required; OAuth, an event or a username alone is not send authorization. No DMs/threads/mentions/files. Max 2000 UTF-16 units, one message. Use the real original source_message_id only for deduplication, not identity proof. Unknown delivery must never be retried using another ID or connection.' : 'Read only this connection saved receipt for the identical original inputs. Does not send or read Discord history. Unknown delivery must not be resent.',
      inputSchema: replySchema, annotations: { readOnlyHint: operation === 'receipt', destructiveHint: false, idempotentHint: true, openWorldHint: operation === 'send' }
    }, async input => {
      try {
        const row = resolveConnection(auth, env, scope);
        const id = env.REPLY_LEDGER.idFromName(await connectionLedgerName(row));
        const response = await env.REPLY_LEDGER.get(id).fetch('https://ledger.internal/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, auth: { userId: auth.userId, clientId: auth.clientId, scope: auth.scope, expiresAt: auth.expiresAt }, input })
        });
        const result = await response.json();
        return response.ok ? toolResult(result) : { ...toolResult(result), isError: true };
      } catch (e) { return toolError(e); }
    });
  }
  return server;
}
export default {
  async fetch(request, env, ctx) {
    const jwtMode = env.AUTH_MODE === '0g0-id-jwt';
    const rpcMode = env.AUTH_MODE === 'service-binding' && !!env.AUTH_SERVER;
    try { connectionPolicies(env); } catch { return Response.json({ error: 'not_configured' }, { status: 503 }); }
    if (!env.MCP_SERVER_URL || !env.AUTH_SERVER_URL || (!jwtMode && !rpcMode) || (jwtMode && env.AUTH_SERVER_URL !== IDP_ISSUER)) return Response.json({ error: 'not_configured' }, { status: 503 });
    let configured; try { configured = new URL(env.MCP_SERVER_URL); } catch { return Response.json({ error: 'not_configured' }, { status: 503 }); }
    if (configured.protocol !== 'https:' || configured.pathname !== '/mcp' || configured.search || configured.hash || configured.username || configured.password || new URL(request.url).origin !== configured.origin) return new Response('Invalid resource', { status: 403 });
    const origin = request.headers.get('Origin');
    if (origin && origin !== configured.origin) return new Response('Invalid origin', { status: 403 });
    const resource = new OAuthResourceServer({
      resourceMetadata: { resource: env.MCP_SERVER_URL, authorization_servers: [env.AUTH_SERVER_URL], bearer_methods_supported: ['header'] },
      requiredScopes: [READ_SCOPE], validateToken: e => async (resource, token) => {
        const verified = jwtMode ? await validateIdpToken(resource, token) : await e.AUTH_SERVER.validateToken(resource, token);
        if (!verified || !Number.isFinite(verified.expiresAt) || verified.expiresAt <= Date.now() / 1000 || typeof verified.userId !== 'string' || !verified.userId || typeof verified.clientId !== 'string' || !verified.clientId) return null;
        return verified;
      },
      handler: { async fetch(req, e, executionCtx) {
        try {
          resolveConnection(executionCtx.auth, e);
          if (new URL(req.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
          const handler = createMcpHandler(() => createServer(e, executionCtx.auth), { corsOptions: false, legacy: 'stateless', allowedHostnames: [new URL(e.MCP_SERVER_URL).hostname], allowedOriginHostnames: [new URL(e.MCP_SERVER_URL).hostname] });
          return await handler(req, e, executionCtx);
        } catch { return Response.json({ error: 'access_denied' }, { status: 403 }); }
      } }
    });
    const response = await resource.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    for (const key of [...headers.keys()]) if (key.toLowerCase().startsWith('access-control-')) headers.delete(key);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};

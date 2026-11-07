export const BOT = 'ichihime';
export const BOT_USER_ID = '1568548424519913482';
export const READ_SCOPE = 'discord:reply:read';
export const WRITE_SCOPE = 'discord:reply:send';
const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;
export class SafeError extends Error {
  constructor(code) { super(code); this.name = 'SafeError'; this.code = code; }
}
export function fail(code) { throw new SafeError(code); }
export function assertOwner(auth, env, scope) {
  if (!env.OWNER_SUBJECT || typeof env.OWNER_SUBJECT !== 'string') fail('not_configured');
  // auth is supplied only by OAuthResourceServer, never by a tool argument/header.
  if (auth?.userId !== env.OWNER_SUBJECT) fail('owner_required');
  if (!Array.isArray(auth.scope) || !auth.scope.includes(scope)) fail('insufficient_scope');
}
export function configuredTargets(env) {
  let targets;
  try { targets = JSON.parse(env.ALLOWED_TARGETS_JSON); } catch { fail('not_configured'); }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20) fail('not_configured');
  return targets.map(t => {
    if (!t || Object.keys(t).sort().join(',') !== 'channel_id,guild_id,type' ||
        typeof t.guild_id !== 'string' || typeof t.channel_id !== 'string' || !SNOWFLAKE.test(t.guild_id) || !SNOWFLAKE.test(t.channel_id) || ![0, 5].includes(t.type)) fail('not_configured');
    return { guild_id: t.guild_id, channel_id: t.channel_id, type: t.type };
  });
}
export function validateReply(input, env) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'channel_url,content,source_message_id') fail('invalid_arguments');
  if (typeof input.channel_url !== 'string' || typeof input.content !== 'string' ||
      typeof input.source_message_id !== 'string' || !SNOWFLAKE.test(input.source_message_id)) fail('invalid_arguments');
  const m = /^https:\/\/discord\.com\/channels\/([1-9][0-9]{16,19})\/([1-9][0-9]{16,19})$/.exec(input.channel_url);
  if (!m) fail('invalid_channel_url');
  if (!configuredTargets(env).some(t => t.guild_id === m[1] && t.channel_id === m[2])) fail('target_not_allowed');
  if (!input.content.trim() || input.content.length > 2000) fail('invalid_content');
  // A single bounded message prevents the upstream split/partial-send path.
  if (/@everyone|@here|<@|<#|<\//i.test(input.content)) fail('mentions_not_allowed');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.content)) fail('invalid_content');
  return { source_message_id: input.source_message_id, guild_id: m[1], channel_id: m[2], content: input.content };
}
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function identity(reply, owner) {
  // Global per-source-message key: changing the destination cannot evade the conflict check.
  const key = await sha256(JSON.stringify(['ichihime-reply-v1', owner, reply.source_message_id]));
  const digest = await sha256(JSON.stringify([BOT, reply.guild_id, reply.channel_id, reply.content]));
  return { key, digest };
}
export async function readBoundedJson(response, maxBytes = 16384) {
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_upstream_response');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('invalid_upstream_response'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('invalid_upstream_response'); }
}
export async function deliver(reply, env) {
  if (!env.GATEWAY_SERVICE || typeof env.GATEWAY_SERVICE.fetch !== 'function' ||
      typeof env.GATEWAY_ADMIN_KEY !== 'string' || !env.GATEWAY_ADMIN_KEY ||
      env.SEND_ENABLED !== 'true') fail('send_not_enabled');
  // There is no user-supplied host/path and no Internet fetch fallback.
  const response = await env.GATEWAY_SERVICE.fetch('https://gateway.internal/send', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}` },
    body: JSON.stringify({ bot: BOT, channel_id: reply.channel_id, content: reply.content })
  });
  if (response.status !== 200 && response.status !== 201) fail('upstream_delivery_unconfirmed');
  const body = await readBoundedJson(response);
  if (!body || typeof body.id !== 'string' || !SNOWFLAKE.test(body.id) || body.channel_id !== reply.channel_id || body.author?.id !== BOT_USER_ID) fail('upstream_delivery_unconfirmed');
  return { message_id: body.id, channel_url: `https://discord.com/channels/${reply.guild_id}/${reply.channel_id}`, message_url: `https://discord.com/channels/${reply.guild_id}/${reply.channel_id}/${body.id}` };
}
export function toolError(error) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof SafeError ? error.code : 'internal_error' }) }], isError: true };
}
export function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

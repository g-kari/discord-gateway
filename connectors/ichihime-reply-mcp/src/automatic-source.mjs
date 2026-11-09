import { fail, readBoundedJson } from './core.mjs';
import { assertSendingEnabled, validateConnectionReply } from './connection-policy.mjs';

// The existing owner-only installation and its one server-configured target.
// Real guild/channel identifiers remain deployment configuration, not source.
const DAY = 24 * 60 * 60 * 1000;
export function assertAutomaticConnection(row) {
  if (row.connection_id !== 'ichihime-legacy' || row.bot !== 'ichihime' ||
      row.ledger_mode !== 'legacy-ichihime-v1' || row.targets.length !== 1 ||
      row.targets[0].type !== 0) fail('automatic_reply_not_configured');
}
export function automaticNotBefore(env) {
  const raw = env.AUTO_REPLY_NOT_BEFORE;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) fail('automatic_reply_not_configured');
  const value = Date.parse(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > Date.now() || new Date(value).toISOString() !== raw) fail('automatic_reply_not_configured');
  return value;
}
export function assertAutomaticEnabled(row, env) {
  assertAutomaticConnection(row);
  automaticNotBefore(env);
  assertSendingEnabled(row, env);
  if (env.AUTO_REPLY_ENABLED !== 'true') fail('automatic_reply_not_enabled');
}
export function validateSourceInput(input, row, withReply = false) {
  assertAutomaticConnection(row);
  const keys = withReply ? 'channel_url,content,source_message_id,source_text_sha256' : 'channel_url,source_message_id,source_text_sha256';
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== keys ||
      typeof input.source_text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.source_text_sha256)) fail('invalid_arguments');
  const reply = validateConnectionReply({ source_message_id: input.source_message_id, channel_url: input.channel_url,
    content: withReply ? input.content : 'source verification' }, row);
  return { ...reply, source_text_sha256: input.source_text_sha256 };
}
export function sourceGuard(reply) {
  return { source_message_id: reply.source_message_id, guild_id: reply.guild_id, channel_id: reply.channel_id,
    source_text_sha256: reply.source_text_sha256 };
}
export async function verifyAutomaticSource(reply, row, env) {
  assertAutomaticConnection(row);
  const notBefore = automaticNotBefore(env);
  if (!env.GATEWAY_SERVICE || typeof env.GATEWAY_SERVICE.fetch !== 'function' ||
      typeof env.GATEWAY_ADMIN_KEY !== 'string' || !env.GATEWAY_ADMIN_KEY) fail('automatic_reply_not_configured');
  let source;
  try {
    const response = await env.GATEWAY_SERVICE.fetch('https://gateway.internal/reply-source', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}` },
      body: JSON.stringify({ bot: 'ichihime', ...sourceGuard(reply) })
    });
    if (response.status !== 200) fail('source_not_verified');
    source = await readBoundedJson(response, 4096);
  } catch { fail('source_not_verified'); }
  const now = Date.now();
  if (!source || source.verified !== true || source.owner_verified !== true || source.self_mentioned !== true || source.bot !== 'ichihime' ||
      source.source_message_id !== reply.source_message_id || source.guild_id !== reply.guild_id ||
      source.channel_id !== reply.channel_id || source.source_text_sha256 !== reply.source_text_sha256 ||
      !['none', 'self'].includes(source.reply_context) ||
      ![source.created_at_ms, source.received_at_ms, source.expires_at_ms].every(Number.isSafeInteger) ||
      source.created_at_ms < notBefore || source.created_at_ms > now + 300000 ||
      source.received_at_ms < notBefore || source.received_at_ms > now + 300000 ||
      source.received_at_ms < source.created_at_ms - 300000 || source.expires_at_ms <= now ||
      source.expires_at_ms !== source.created_at_ms + DAY) fail('source_not_verified');
  return { ...source, channel_url: `https://discord.com/channels/${reply.guild_id}/${reply.channel_id}` };
}

import { fail, configuredTargets, validateReply, identity, sha256, readBoundedJson, READ_SCOPE } from './core.mjs';
// The unchanged Gateway recognizes exactly these two names. Never accept a
// client-supplied Bot, URL, expected receipt identity, or policy row.
const BOTS = Object.freeze({ ichihime: '1568548424519913482', croissand: '1568508479293890673' });
const identifier = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(s);
export function connectionPolicies(env) {
  if (typeof env.CONNECTION_POLICIES_JSON !== 'string' || env.CONNECTION_POLICIES_JSON.length > 65536) fail('not_configured');
  let rows; try { rows = JSON.parse(env.CONNECTION_POLICIES_JSON); } catch { fail('not_configured'); }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) fail('not_configured');
  const clients = new Set(), ids = new Set(), legacyOwners = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'bot,client_id,connection_id,enabled,ledger_mode,owner_subject,targets' ||
        typeof row.connection_id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.connection_id) ||
        !identifier(row.client_id) || !identifier(row.owner_subject) || typeof row.bot !== 'string' || !Object.hasOwn(BOTS, row.bot) ||
        typeof row.enabled !== 'boolean' || !['isolated-v1', 'legacy-ichihime-v1'].includes(row.ledger_mode) ||
        clients.has(row.client_id) || ids.has(row.connection_id)) fail('not_configured');
    const targets = configuredTargets({ ALLOWED_TARGETS_JSON: JSON.stringify(row.targets) });
    const targetIds = targets.map(t => t.channel_id);
    if (new Set(targetIds).size !== targetIds.length) fail('not_configured');
    if (row.ledger_mode === 'legacy-ichihime-v1') {
      if (row.bot !== 'ichihime' || row.connection_id !== 'ichihime-legacy' || legacyOwners.size !== 0) fail('not_configured');
      legacyOwners.add(row.owner_subject);
    } else if (row.connection_id === 'ichihime-legacy') fail('not_configured');
    clients.add(row.client_id); ids.add(row.connection_id);
    return Object.freeze({ ...row, bot_user_id: BOTS[row.bot], targets: Object.freeze(targets) });
  });
}
export function resolveConnection(auth, env, scope = READ_SCOPE) {
  const rows = connectionPolicies(env); // Validate the complete policy, including unrelated rows.
  if (!identifier(auth?.userId) || !identifier(auth?.clientId)) fail('access_denied');
  const row = rows.find(p => p.client_id === auth.clientId);
  if (!row || auth.userId !== row.owner_subject) fail('access_denied');
  if (!Array.isArray(auth.scope) || !auth.scope.includes(READ_SCOPE) || !auth.scope.includes(scope)) fail('insufficient_scope');
  if (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now() / 1000) fail('access_denied');
  return row;
}
export function validateConnectionReply(input, row) {
  return validateReply(input, { ALLOWED_TARGETS_JSON: JSON.stringify(row.targets) });
}
export async function connectionLedgerName(row) {
  if (row.ledger_mode === 'legacy-ichihime-v1') return `ichihime-owner:${row.owner_subject}`;
  // client_id is deliberately excluded: registration rotation must not reset dedup.
  return `discord-reply-connection-v1:${await sha256(JSON.stringify([row.connection_id, row.owner_subject]))}`;
}
export async function connectionIdentity(reply, row) {
  if (row.ledger_mode === 'legacy-ichihime-v1') return identity(reply, row.owner_subject);
  return {
    key: await sha256(JSON.stringify(['discord-reply-connection-v1', row.connection_id, row.owner_subject, reply.source_message_id])),
    digest: await sha256(JSON.stringify([row.bot, reply.guild_id, reply.channel_id, reply.content]))
  };
}
export function assertSendingEnabled(row, env) {
  if (env.SEND_ENABLED !== 'true' || row.enabled !== true || typeof env.GATEWAY_ADMIN_KEY !== 'string' || !env.GATEWAY_ADMIN_KEY || !env.GATEWAY_SERVICE || typeof env.GATEWAY_SERVICE.fetch !== 'function') fail('send_not_enabled');
}
export async function deliverConnection(reply, row, env, replySource) {
  assertSendingEnabled(row, env);
  const response = await env.GATEWAY_SERVICE.fetch('https://gateway.internal/send', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GATEWAY_ADMIN_KEY}` },
    body: JSON.stringify({ bot: row.bot, channel_id: reply.channel_id, content: reply.content,
      ...(replySource === undefined ? {} : { reply_source: replySource }) })
  });
  if (response.status !== 200 && response.status !== 201) fail('upstream_delivery_unconfirmed');
  const body = await readBoundedJson(response);
  if (!body || typeof body.id !== 'string' || !/^[1-9][0-9]{16,19}$/.test(body.id) || body.channel_id !== reply.channel_id || body.author?.id !== row.bot_user_id) fail('upstream_delivery_unconfirmed');
  return { message_id: body.id, channel_url: `https://discord.com/channels/${reply.guild_id}/${reply.channel_id}`, message_url: `https://discord.com/channels/${reply.guild_id}/${reply.channel_id}/${body.id}` };
}

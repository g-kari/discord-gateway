// Real OAuth verifier, MCP handler, both SQLite DOs, and guarded Gateway send.
// All identities/tokens/events/network responses are local synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const { Miniflare } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const RESOURCE = 'https://reply.test/mcp', ISSUER = 'https://id.0g0.xyz';
const G = '111111111111111111', C = '222222222222222222';
const OWNER = '333933401314951168', BOT = '1568548424519913482';
const policy = { connection_id: 'ichihime-legacy', client_id: 'synthetic-client', owner_subject: 'synthetic-owner', bot: 'ichihime',
  targets: [{ guild_id: G, channel_id: C, type: 0 }], enabled: true, ledger_mode: 'legacy-ichihime-v1' };
const key = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(key.publicKey), kid: 'synthetic-auto-key', use: 'sig', alg: 'ES256' };
async function token(patch = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISSUER, aud: RESOURCE, sub: policy.owner_subject, cid: policy.client_id,
    scope: 'discord:reply:read discord:reply:send', iat: now, exp: now + 900, jti: crypto.randomUUID(), ...patch })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(key.privateKey);
}
let seq = 0n;
function message(patch = {}) {
  return { id: (((BigInt(Date.now() - 1000) - 1420070400000n) << 22n) + ++seq).toString(),
    guild_id: G, channel_id: C, author: { id: OWNER, username: 'synthetic-owner', bot: false },
    content: `<@${BOT}> こんにちは`, mentions: [{ id: BOT }], mention_roles: [], mention_everyone: false, ...patch };
}
const source = await readFile(new URL('../../../worker.js', import.meta.url), 'utf8');
const gatewayScript = source.replace('export default {', 'const productionWorker = {') + `
export class FixtureGateway extends Gateway {
 async scheduleAlarmLocked() {}
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/test/event') {
   const event = await request.json(), ws = {};
   this._sockets.ichihime = {ws};
   this.saveState({...this.loadState('ichihime'), botUserId:'${BOT}'}, 'ichihime');
   await this.handleSocketMessage('ichihime', ws, JSON.stringify(event));
   return new Response('ok');
  }
  if (path === '/test/forward') {
   const {id} = await request.json();
   const rows = this.ctx.storage.sql.exec('SELECT body FROM outbox WHERE bot = ? AND request_id = ?', 'ichihime', 'discord-' + id).toArray();
   return Response.json(rows.length ? JSON.parse(rows[0].body) : null);
  }
  return super.fetch(request);
 }
}
export default productionWorker;`;

async function fixture() {
  const persist = await mkdtemp(join(tmpdir(), 'automatic-chain-'));
  const calls = [], network = []; let mf;
  const cutoff = new Date(Date.now() - 60000).toISOString();
  return { calls, network, get mf() { return mf; }, async start(patch = {}) {
    await mf?.dispose();
    mf = new Miniflare({ durableObjectsPersist: persist, workers: [
      { name: 'ingress', modules: true, serviceBindings: { REPLY: 'reply' }, script: `export default {fetch(r,e){const h=new Headers(r.headers);h.set('Host',new URL(r.url).host);return e.REPLY.fetch(new Request(r,{headers:h}));}}` },
      { name: 'reply', modules: true, script: await readFile(new URL('../dist/shared-worker.mjs', import.meta.url), 'utf8'),
        compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
        durableObjects: { REPLY_LEDGER: { className: 'ReplyLedger', useSQLite: true } },
        bindings: { AUTH_MODE: '0g0-id-jwt', AUTH_SERVER_URL: ISSUER, MCP_SERVER_URL: RESOURCE,
          CONNECTION_POLICIES_JSON: JSON.stringify([policy]), SEND_ENABLED: 'true', AUTO_REPLY_ENABLED: 'true',
          AUTO_REPLY_NOT_BEFORE: cutoff, GATEWAY_ADMIN_KEY: 'synthetic-admin', ...patch },
        serviceBindings: { GATEWAY_SERVICE: 'gateway' }, outboundService: req => {
          network.push(req.url); assert.equal(req.headers.get('Authorization'), null);
          return req.url === ISSUER + '/.well-known/jwks.json' ? Response.json({ keys: [jwk] }) : new Response('blocked', { status: 500 });
        } },
      { name: 'gateway', modules: true, script: gatewayScript, compatibilityDate: '2025-11-01',
        durableObjects: { GATEWAY: { className: 'FixtureGateway', useSQLite: true } },
        bindings: { ADMIN_KEY: 'synthetic-admin', DISCORD_BOT_TOKEN_ICHICHIME: 'synthetic-bot-token',
          AUTO_REPLY_TARGET_JSON: JSON.stringify(policy.targets[0]) }, outboundService: async req => {
          assert.equal(req.url, `https://discord.com/api/v10/channels/${C}/messages`);
          assert.equal(req.headers.get('Authorization'), 'Bot synthetic-bot-token');
          calls.push(await req.json());
          return Response.json({ id: '1569199999999999999', channel_id: C, author: { id: BOT } }, { status: 201 });
        } }
    ] }); await mf.ready;
  }, async close() { await mf?.dispose(); await rm(persist, { recursive: true, force: true }); } };
}
async function rpc(f, method, params = {}, bearer) {
  const response = await f.mf.dispatchFetch(RESOURCE, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const raw = await response.text(); let body;
  try { body = JSON.parse(raw); } catch { const line = raw.split('\n').find(x => x.startsWith('data: ')); body = line ? JSON.parse(line.slice(6)) : null; }
  let value; try { value = JSON.parse(body.result.content[0].text); } catch {}
  return { status: response.status, body, value, raw };
}
const tool = async (f, name, args = {}, bearer) => rpc(f, 'tools/call', { name, arguments: args }, bearer || await token());
async function event(f, t, d) {
  const ns = await f.mf.getDurableObjectNamespace('GATEWAY', 'gateway'); const stub = ns.get(ns.idFromName('global'));
  const res = await stub.fetch('https://local/test/event', { method: 'POST', body: JSON.stringify({ op: 0, t, d }) });
  assert.equal(res.status, 200);
  return (await stub.fetch('https://local/test/forward', { method: 'POST', body: JSON.stringify({ id: d.id }) })).json();
}
function input(m, forwarded) {
  return { source_message_id: m.id, channel_url: `https://discord.com/channels/${G}/${C}`,
    source_text_sha256: createHash('sha256').update(forwarded.text, 'utf8').digest('hex') };
}
const reply = args => ({ ...args, content: 'こんにちは。動作確認できました。' });
const manual = ({ source_text_sha256, ...args }) => args;

test('automatic chain: discovery, exact authenticated source, guarded delivery and durable shared dedup', async () => {
  const f = await fixture(); try {
    await f.start(); assert.equal((await rpc(f, 'tools/list')).status, 401);
    const list = await rpc(f, 'tools/list', {}, await token());
    assert.deepEqual(list.body.result.tools.map(t => t.name).sort(), ['discord_reply_receipt', 'discord_reply_status', 'discord_send_automatic_reply', 'discord_send_reply', 'discord_verify_reply_source'].sort());
    const status = (await tool(f, 'discord_reply_status')).value;
    assert.equal(status.send_scope_granted, true); assert.equal(status.automatic_reply_enabled, true);
    const readStatus = (await tool(f, 'discord_reply_status', {}, await token({ scope: 'discord:reply:read' }))).value;
    assert.equal(readStatus.send_scope_granted, false);
    const m = message(); const forwarded = await event(f, 'MESSAGE_CREATE', m); const args = input(m, forwarded);
    const verified = (await tool(f, 'discord_verify_reply_source', args)).value;
    assert.equal(verified.owner_verified, true); assert.equal(verified.self_mentioned, true); assert.equal(verified.reply_context, 'none');
    assert.equal((await tool(f, 'discord_verify_reply_source', { ...args, source_text_sha256: 'b'.repeat(64) })).value.error, 'source_not_verified');
    assert.equal((await tool(f, 'discord_send_automatic_reply', reply(args), await token({ scope: 'discord:reply:read' }))).value.error, 'insufficient_scope');
    const sent = (await tool(f, 'discord_send_automatic_reply', reply(args))).value;
    assert.equal(sent.status, 'sent'); assert.deepEqual(f.calls, [{ content: reply(args).content, allowed_mentions: { parse: [] } }]);
    assert.deepEqual((await tool(f, 'discord_reply_receipt', manual(reply(args)))).value, sent);
    assert.deepEqual((await tool(f, 'discord_send_reply', manual(reply(args)))).value, sent);
    await f.start(); assert.deepEqual((await tool(f, 'discord_send_automatic_reply', reply(args))).value, sent);
    assert.equal(f.calls.length, 1); assert.ok(f.network.every(url => url === ISSUER + '/.well-known/jwks.json'));
  } finally { await f.close(); }
});
test('automatic chain: Bot source, other/unknown references, changed text and revoked source never send', async () => {
  const f = await fixture(); try {
    await f.start();
    for (const patch of [
      { author: { id: '555555555555555555', username: 'synthetic-bot', bot: true }, mentions: [{ id: BOT }], content: `<@${BOT}> test` },
      { message_reference: { message_id: '666666666666666666', channel_id: C, guild_id: G }, referenced_message: { author: { id: '555555555555555555' } } },
      { message_reference: { message_id: '666666666666666666', channel_id: C, guild_id: G }, referenced_message: null }
    ]) {
      const m = message(patch); const forwarded = await event(f, 'MESSAGE_CREATE', m); assert.ok(forwarded);
      const args = input(m, forwarded); assert.equal((await tool(f, 'discord_verify_reply_source', args)).value.error, 'source_not_verified');
      assert.equal((await tool(f, 'discord_send_automatic_reply', reply(args))).value.error, 'source_not_verified');
    }
    const m = message(); const args = input(m, await event(f, 'MESSAGE_CREATE', m));
    assert.equal((await tool(f, 'discord_verify_reply_source', args)).value.verified, true);
    await event(f, 'MESSAGE_UPDATE', { id: m.id, guild_id: G, channel_id: C, content: 'edited' });
    assert.equal((await tool(f, 'discord_send_automatic_reply', reply(args))).value.error, 'source_not_verified');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('automatic chain: activation cutoff and auto stop reject new sends without changing manual receipt access', async () => {
  const f = await fixture(); try {
    await f.start({ AUTO_REPLY_ENABLED: 'false' }); const m = message(); const args = input(m, await event(f, 'MESSAGE_CREATE', m));
    assert.equal((await tool(f, 'discord_send_automatic_reply', reply(args))).value.error, 'automatic_reply_not_enabled');
    assert.equal((await tool(f, 'discord_reply_receipt', manual(reply(args)))).value.status, 'not_found');
    await f.start({ AUTO_REPLY_NOT_BEFORE: new Date().toISOString() });
    assert.equal((await tool(f, 'discord_verify_reply_source', args)).value.error, 'source_not_verified');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

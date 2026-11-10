// Synthetic OAuth tokens, local JWKS, Gateway responses and SQLite only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { READ_SCOPE, WRITE_SCOPE } from '../src/core.mjs';
const { Miniflare } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const RESOURCE = 'https://reply.test/mcp', ISSUER = 'https://id.0g0.xyz';
const METADATA = 'https://reply.test/.well-known/oauth-protected-resource/mcp';
const G = '111111111111111111', C = '222222222222222222', HASH = 'a'.repeat(64);
const row = { connection_id: 'ichihime-legacy', client_id: 'synthetic-client', owner_subject: 'synthetic-owner', bot: 'ichihime',
  targets: [{ guild_id: G, channel_id: C, type: 0 }], enabled: true, ledger_mode: 'legacy-ichihime-v1' };
const key = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(key.publicKey), kid: 'synthetic-scope-key', use: 'sig', alg: 'ES256' };
async function token(patch = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISSUER, aud: RESOURCE, sub: row.owner_subject, cid: row.client_id,
    scope: `${READ_SCOPE} ${WRITE_SCOPE}`, iat: now, exp: now + 900, jti: crypto.randomUUID(), ...patch })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(key.privateKey);
}
const manual = (id = '333333333333333333') => ({ source_message_id: id, channel_url: `https://discord.com/channels/${G}/${C}`, content: 'Synthetic scope test reply' });
const automatic = (id = '333333333333333334') => ({ ...manual(id), source_text_sha256: HASH });
const source = ({ content, ...args }) => args;
const receipt = ({ source_text_sha256, ...args }) => args;
const challenge = `Bearer resource_metadata="${METADATA}", error="insufficient_scope", error_description="Discord reply send permission is required", scope="${READ_SCOPE} ${WRITE_SCOPE}"`;

async function fixture() {
  const persist = await mkdtemp(join(tmpdir(), 'oauth-tool-auth-'));
  const calls = [], network = []; let mf;
  const cutoff = new Date(Date.now() - 60000).toISOString();
  return { calls, network, get mf() { return mf; }, async start() {
    await mf?.dispose();
    mf = new Miniflare({ cf: false, durableObjectsPersist: persist, workers: [
      { name: 'ingress', modules: true, serviceBindings: { REPLY: 'reply' }, script: `export default {fetch(r,e){const h=new Headers(r.headers);h.set('Host',new URL(r.url).host);return e.REPLY.fetch(new Request(r,{headers:h}));}}` },
      { name: 'reply', modules: true, script: await readFile(new URL('../dist/shared-worker.mjs', import.meta.url), 'utf8'),
        compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
        durableObjects: { REPLY_LEDGER: { className: 'ReplyLedger', useSQLite: true } },
        bindings: { AUTH_MODE: '0g0-id-jwt', AUTH_SERVER_URL: ISSUER, MCP_SERVER_URL: RESOURCE,
          CONNECTION_POLICIES_JSON: JSON.stringify([row]), SEND_ENABLED: 'true', AUTO_REPLY_ENABLED: 'true',
          AUTO_REPLY_NOT_BEFORE: cutoff, GATEWAY_ADMIN_KEY: 'synthetic-not-a-credential' },
        serviceBindings: { GATEWAY_SERVICE: async req => {
          assert.equal(req.headers.get('Authorization'), 'Bearer synthetic-not-a-credential');
          const body = await req.json(); calls.push({ url: req.url, body });
          if (req.url === 'https://gateway.internal/reply-source') {
            if (body.source_text_sha256 !== HASH) return Response.json({ error: 'source_not_verified' }, { status: 404 });
            const created = Date.now() - 1000;
            return Response.json({ ...body, verified: true, owner_verified: true, self_mentioned: true,
              reply_context: 'none', created_at_ms: created, received_at_ms: created, expires_at_ms: created + 86400000 });
          }
          assert.equal(req.url, 'https://gateway.internal/send');
          assert.equal(body.bot, 'ichihime'); assert.equal(body.channel_id, C);
          return Response.json({ id: '444444444444444444', channel_id: C, author: { id: '1568548424519913482' } }, { status: 201 });
        } }, outboundService: req => {
          network.push(req.url); assert.equal(req.headers.get('Authorization'), null);
          assert.equal(req.url, ISSUER + '/.well-known/jwks.json');
          return Response.json({ keys: [jwk] });
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
  return { status: response.status, headers: response.headers, body, value, raw };
}
const tool = (f, name, args, bearer) => rpc(f, 'tools/call', { name, arguments: args }, bearer);
function assertChallenge(result) {
  assert.equal(result.status, 200, result.raw);
  assert.deepEqual(result.value, { error: 'insufficient_scope' });
  assert.equal(result.body.result.isError, true);
  assert.deepEqual(result.body.result._meta, { 'mcp/www_authenticate': [challenge] });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
}

test('scope workerd: protected-resource baseline and all five tool security descriptors survive SDK serialization', async () => {
  const f = await fixture(); try {
    await f.start();
    const metadata = await f.mf.dispatchFetch(METADATA);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { resource: RESOURCE, authorization_servers: [ISSUER],
      scopes_supported: [READ_SCOPE], bearer_methods_supported: ['header'] });
    assert.equal(metadata.headers.get('Cache-Control'), 'no-store');
    assert.equal(metadata.headers.get('Access-Control-Allow-Origin'), null);
    const unauthenticated = await rpc(f, 'tools/list');
    assert.equal(unauthenticated.status, 401);
    assert.ok(unauthenticated.headers.get('WWW-Authenticate').includes(`resource_metadata="${METADATA}"`));
    assert.ok(unauthenticated.headers.get('WWW-Authenticate').includes(`scope="${READ_SCOPE}"`));
    const listed = await rpc(f, 'tools/list', {}, await token({ scope: READ_SCOPE }));
    assert.equal(listed.status, 200);
    const tools = listed.body.result.tools;
    assert.equal(tools.length, 5);
    for (const t of tools) {
      const sends = ['discord_send_reply', 'discord_send_automatic_reply'].includes(t.name);
      assert.deepEqual(t._meta.securitySchemes, [{ type: 'oauth2', scopes: sends ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE] }], t.name);
      assert.equal(t.annotations.readOnlyHint, !sends);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('scope workerd: read token retains status, source verification and receipts while both sends challenge without reservation or dispatch', async () => {
  const f = await fixture(); try {
    await f.start(); const read = await token({ scope: READ_SCOPE });
    const status = await tool(f, 'discord_reply_status', {}, read);
    assert.equal(status.value.send_scope_granted, false); assert.equal(status.body.result._meta, undefined);
    const verified = await tool(f, 'discord_verify_reply_source', source(automatic()), read);
    assert.equal(verified.value.verified, true); assert.equal(verified.body.result._meta, undefined);
    const before = f.calls.length;
    for (const [name, args] of [['discord_send_reply', manual()], ['discord_send_automatic_reply', automatic()]]) {
      for (let i = 0; i < 2; i++) assertChallenge(await tool(f, name, args, read));
      assert.equal((await tool(f, 'discord_reply_receipt', receipt(args), read)).value.status, 'not_found');
    }
    assert.equal(f.calls.length, before);
    await f.start();
    for (const args of [manual(), automatic()]) assert.equal((await tool(f, 'discord_reply_receipt', receipt(args), read)).value.status, 'not_found');
    assert.equal(f.calls.length, before);
    assert.ok(f.network.every(url => url === ISSUER + '/.well-known/jwks.json'));
  } finally { await f.close(); }
});

test('scope workerd: full synthetic grant sends once after step-up, retaining permanent cross-tool dedup across restart', async () => {
  const f = await fixture(); try {
    await f.start(); const read = await token({ scope: READ_SCOPE }), write = await token();
    for (const [name, args] of [['discord_send_reply', manual()], ['discord_send_automatic_reply', automatic()]]) {
      assertChallenge(await tool(f, name, args, read));
      const sent = await tool(f, name, args, write);
      assert.equal(sent.value.status, 'sent', sent.raw); assert.equal(sent.body.result._meta, undefined);
      assert.deepEqual((await tool(f, 'discord_reply_receipt', receipt(args), read)).value, sent.value);
      assert.deepEqual((await tool(f, 'discord_send_reply', receipt(args), write)).value, sent.value);
    }
    assert.equal(f.calls.filter(c => c.url.endsWith('/send')).length, 2);
    await f.start();
    assert.equal((await tool(f, 'discord_send_reply', manual(), write)).value.status, 'sent');
    assert.equal((await tool(f, 'discord_send_automatic_reply', automatic(), write)).value.status, 'sent');
    assert.equal(f.calls.filter(c => c.url.endsWith('/send')).length, 2);
  } finally { await f.close(); }
});

test('scope workerd: invalid authentication and non-scope policy failures never become a send-consent challenge', async () => {
  const f = await fixture(); try {
    await f.start();
    for (const bearer of ['not-a-token', await token({ aud: 'https://other.test/mcp' }), await token({ exp: 1 }), await token({ iss: 'https://other.test' })]) {
      const r = await tool(f, 'discord_send_reply', manual(), bearer);
      assert.equal(r.status, 401); assert.equal(r.body?.result?._meta, undefined);
      assert.ok(r.headers.get('WWW-Authenticate').includes('error="invalid_token"'));
    }
    for (const patch of [{ sub: 'outsider' }, { cid: 'unknown-client' }, { scope: WRITE_SCOPE }]) {
      const r = await tool(f, 'discord_send_automatic_reply', automatic(), await token(patch));
      assert.equal(r.status, 403); assert.equal(r.body?.result?._meta, undefined);
    }
    assert.equal(f.calls.length, 0);
    const write = await token();
    for (const [name, args, error] of [
      ['discord_send_reply', { ...manual(), channel_url: `https://discord.com/channels/${G}/222222222222222223` }, 'target_not_allowed'],
      ['discord_send_automatic_reply', { ...automatic(), source_text_sha256: 'b'.repeat(64) }, 'source_not_verified']
    ]) {
      const r = await tool(f, name, args, write);
      assert.equal(r.value.error, error); assert.equal(r.body.result._meta, undefined);
    }
    assert.equal(f.calls.filter(c => c.url.endsWith('/send')).length, 0);
    assert.equal((await tool(f, 'discord_reply_receipt', receipt(automatic()), await token({ scope: READ_SCOPE }))).value.status, 'not_found');
  } finally { await f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const { Miniflare } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const script = await readFile(new URL('../dist/worker.mjs', import.meta.url), 'utf8');
const issuer = 'https://id.0g0.xyz', resource = 'https://reply.test/mcp';
const G = '111111111111111111', C = '222222222222222222';
const signingKey = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(signingKey.publicKey), kid: 'synthetic-workerd-key', use: 'sig', alg: 'ES256' };
const seconds = Math.floor(Date.now() / 1000);
const base = { iss: issuer, sub: 'synthetic-owner', aud: resource, iat: seconds, exp: seconds + 900, cid: 'synthetic-client', scope: 'discord:reply:read discord:reply:send', jti: 'synthetic-jti' };
const sign = (patch = {}, header = {}) => new SignJWT({ ...base, ...patch }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid, ...header }).sign(signingKey.privateKey);
const gateway = `let n=0;export default {async fetch(r){if(new URL(r.url).pathname==='/count')return Response.json(n);n++;const b=await r.json();return Response.json({id:'444444444444444444',channel_id:b.channel_id,author:{id:'1568548424519913482'}},{status:201});}}`;
async function fixture(jwksResponse = () => Response.json({ keys: [jwk] }), env = {}) {
  const network = [];
  const persist = await mkdtemp(join(tmpdir(), 'ichihime-jwt-'));
  const mf = new Miniflare({ durableObjectsPersist: persist, workers: [
    { name: 'ingress', modules: true, serviceBindings: { REPLY: 'reply' }, script: `export default {fetch(r,e){const h=new Headers(r.headers);h.set('Host',new URL(r.url).host);return e.REPLY.fetch(new Request(r,{headers:h}));}}` },
    { name: 'reply', modules: true, script, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], durableObjects: { REPLY_LEDGER: { className: 'ReplyLedger', useSQLite: true } }, bindings: { AUTH_MODE: '0g0-id-jwt', AUTH_SERVER_URL: issuer, MCP_SERVER_URL: resource, OWNER_SUBJECT: 'synthetic-owner', ALLOWED_TARGETS_JSON: JSON.stringify([{ guild_id: G, channel_id: C, type: 0 }]), SEND_ENABLED: 'true', GATEWAY_ADMIN_KEY: 'synthetic-not-a-credential', ...env }, serviceBindings: { GATEWAY_SERVICE: 'gateway' }, outboundService: req => { network.push({ url: req.url, authorization: req.headers.get('Authorization') }); return req.url === issuer + '/.well-known/jwks.json' ? jwksResponse() : new Response('Network blocked', { status: 500 }); } },
    { name: 'gateway', modules: true, script: gateway }
  ] });
  await mf.ready;
  return { mf, network, async close() { await mf.dispose(); await rm(persist, { recursive: true, force: true }); } };
}
async function rpc(f, method, params = {}, token) {
  const response = await f.mf.dispatchFetch(resource, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const raw = await response.text(); let body;
  try { body = JSON.parse(raw); } catch { const line = raw.split('\n').find(x => x.startsWith('data: ')); body = line ? JSON.parse(line.slice(6)) : null; }
  return { status: response.status, body };
}
test('workerd production JWT mode authenticates real ES256 fixtures without AUTH_SERVER binding', async () => {
  const f = await fixture();
  try {
    assert.equal((await rpc(f, 'tools/list')).status, 401);
    const owner = await sign(); assert.equal((await rpc(f, 'tools/list', {}, owner)).body.result.tools.length, 3);
    for (const [patch, status] of [[{ sub: 'outsider' }, 403], [{ aud: 'https://other.test/mcp' }, 401], [{ iss: 'https://evil.test' }, 401], [{ cid: undefined }, 401], [{ exp: seconds - 1 }, 401], [{ iat: seconds + 60 }, 401], [{ aud: [resource, 'https://other.test/mcp'] }, 401], [{ scope: 'discord:reply:send' }, 403], [{ scope: undefined, cid: undefined }, 401]]) assert.equal((await rpc(f, 'tools/list', {}, await sign(patch))).status, status);
    const args = { source_message_id: '333333333333333333', channel_url: `https://discord.com/channels/${G}/${C}`, content: 'Synthetic JWT reply' };
    const readOnly = await rpc(f, 'tools/call', { name: 'discord_send_reply', arguments: args }, await sign({ scope: 'discord:reply:read' }));
    assert.equal(JSON.parse(readOnly.body.result.content[0].text).error, 'insufficient_scope');
    for (let i = 0; i < 2; i++) { const r = await rpc(f, 'tools/call', { name: 'discord_send_reply', arguments: args }, owner); assert.equal(JSON.parse(r.body.result.content[0].text).status, 'sent'); }
    const gatewayStub = await f.mf.getWorker('gateway'); assert.equal(await (await gatewayStub.fetch('https://gateway.internal/count')).json(), 1);
    assert.deepEqual(f.network, [{ url: issuer + '/.well-known/jwks.json', authorization: null }]);
  } finally { await f.close(); }
});
test('workerd production JWT mode rejects missing mode or issuer configuration', async () => {
  for (const env of [{ AUTH_MODE: '' }, { AUTH_MODE: 'service-binding' }, { AUTH_SERVER_URL: 'https://evil.test' }]) { const f = await fixture(undefined, env); try { assert.equal((await rpc(f, 'tools/list', {}, await sign())).status, 503); assert.equal(f.network.length, 0); } finally { await f.close(); } }
});
for (const [name, reply] of [['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/jwks' } })], ['oversized JWKS', () => Response.json({ keys: [jwk], padding: 'x'.repeat(17000) })], ['unavailable JWKS', () => new Response('unavailable', { status: 503 })]]) test('workerd production JWT mode fails closed for ' + name, async () => { const f = await fixture(reply); try { const t = await sign(); assert.equal((await rpc(f, 'tools/list', {}, t)).status, 401); assert.equal((await rpc(f, 'tools/list', {}, t)).status, 401); assert.equal(f.network.length, 1); } finally { await f.close(); } });

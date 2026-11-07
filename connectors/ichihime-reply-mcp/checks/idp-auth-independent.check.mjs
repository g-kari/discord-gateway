import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, CompactSign } from 'jose';
import { createIdpTokenValidator, IDP_ISSUER, IDP_JWKS } from '../src/idp-auth.mjs';
const pair = await generateKeyPair('ES256');
const nextPair = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'independent-a', alg: 'ES256', use: 'sig' };
const nextJwk = { ...await exportJWK(nextPair.publicKey), kid: 'independent-b', alg: 'ES256', use: 'sig' };
const resource = 'https://independent.test/mcp';
const epoch = 2000000000;
const claims = { iss: IDP_ISSUER, aud: resource, sub: 'synthetic-owner', cid: 'synthetic-client', scope: 'discord:reply:read discord:reply:send', iat: epoch, exp: epoch + 900, jti: 'synthetic-audit' };
const sign = (patch = {}, header = {}, key = pair.privateKey) => new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid, ...header }).sign(key);
const rawSign = value => new CompactSign(new TextEncoder().encode(value)).setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(pair.privateKey);
function fixture(responder = () => Response.json({ keys: [jwk] })) {
  const calls = []; let time = epoch * 1000;
  const validate = createIdpTokenValidator({ now: () => time, fetcher: async (url, init) => { calls.push({ url, init }); return responder(url, init); } });
  return { validate, calls, advance: ms => { time += ms; } };
}
for (const [name, patch] of [
  ['single element aud array', { aud: [resource] }], ['subject object', { sub: {} }], ['subject whitespace', { sub: ' \n' }], ['subject too long', { sub: 'x'.repeat(129) }], ['client too long', { cid: 'x'.repeat(2049) }], ['jti object', { jti: {} }], ['scope tab', { scope: 'discord:reply:read\tdiscord:reply:send' }], ['scope DEL', { scope: 'discord:reply:read\x7f' }], ['scope quote', { scope: 'discord:reply:read"' }], ['scope backslash', { scope: 'discord:reply:read\\' }], ['too many scopes', { scope: Array.from({ length: 51 }, (_, i) => 's'+i).join(' ') }], ['scope over limit', { scope: 's'.repeat(4097) }]
]) test('independent rejects ' + name, async () => { const f = fixture(); assert.equal(await f.validate(resource, await sign(patch)), null); });
for (const field of ['exp', 'iat']) for (const number of ['1e309', '-1e309']) test(`independent rejects signed ${field}=${number}`, async () => {
  const json = JSON.stringify(claims).replace(new RegExp(`"${field}":\\d+`), `"${field}":${number}`);
  const f = fixture(); assert.equal(await f.validate(resource, await rawSign(json)), null);
});
for (const header of [{ x5c: [] }, { jku: null }, { jwk: {} }, { x5u: '' }]) test('independent rejects token key locator ' + Object.keys(header)[0], async () => { const f = fixture(); assert.equal(await f.validate(resource, await sign({}, header)), null); assert.equal(f.calls.length, 0); });
for (const [name, data] of [
  ['too many keys', { keys: Array.from({ length: 9 }, (_, i) => ({ ...jwk, kid: 'key'+i })) }],
  ['sign operation', { keys: [{ ...jwk, key_ops: ['sign'] }] }],
  ['duplicate verify operation', { keys: [{ ...jwk, key_ops: ['verify', 'verify'] }] }],
  ['null operations', { keys: [{ ...jwk, key_ops: null }] }],
  ['non-array operations', { keys: [{ ...jwk, key_ops: 'verify' }] }],
  ['invalid point', { keys: [{ ...jwk, x: 'AAAA', y: 'BBBB' }] }],
]) test('independent rejects JWKS ' + name, async () => { const f = fixture(() => Response.json(data)); assert.equal(await f.validate(resource, await sign()), null); });
test('independent rejects malformed UTF-8 JWKS', async () => { const f = fixture(() => new Response(Uint8Array.from([0xc0,0xaf]), { headers: { 'Content-Type': 'application/json' } })); assert.equal(await f.validate(resource, await sign()), null); });
test('independent enforces advertised length before reading', async () => { let reads = 0; const f = fixture(() => new Response(new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } })); assert.equal(await f.validate(resource, await sign()), null); assert.equal(reads, 0); });
test('independent enforces streamed bytes without length header and cancels', async () => {
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }));
  assert.equal(await f.validate(resource, await sign()), null); assert.equal(cancelled, true);
});
test('independent aborts an unresponsive JWKS fetch at 3 seconds; concurrent callers share failure', async () => {
  let observedAbort = false;
  const f = fixture((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true })));
  const token = await sign(); const began = performance.now();
  assert.deepEqual(await Promise.all([f.validate(resource, token), f.validate(resource, token)]), [null, null]);
  assert.ok(observedAbort); assert.ok(performance.now() - began >= 2900); assert.ok(performance.now() - began < 5000); assert.equal(f.calls.length, 1);
  assert.equal(await f.validate(resource, token), null); assert.equal(f.calls.length, 1);
});
test('independent timeout covers a stalled JWKS response body', async () => {
  let aborted = false;
  const f = fixture((_url, { signal }) => new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true }); } }), { headers: { 'Content-Type': 'application/json' } }));
  const began = performance.now(); assert.equal(await f.validate(resource, await sign()), null); assert.ok(aborted); assert.ok(performance.now() - began >= 2900); assert.ok(performance.now() - began < 5000);
});
test('independent cache remains usable after invalid signature without new fetch', async () => {
  const f = fixture(); assert.ok(await f.validate(resource, await sign())); f.advance(30001);
  for (let i=0; i<5; i++) assert.equal(await f.validate(resource, await sign({}, {}, nextPair.privateKey)), null);
  assert.ok(await f.validate(resource, await sign())); assert.equal(f.calls.length, 1);
});
test('independent concurrent unknown kid refresh is deduplicated and validates rotated key', async () => {
  let rotated = false;
  const f = fixture(async () => { await new Promise(r => setTimeout(r, 5)); return Response.json({ keys: rotated ? [nextJwk] : [jwk] }); });
  assert.ok(await f.validate(resource, await sign())); rotated = true; f.advance(30000);
  const token = await sign({}, { kid: nextJwk.kid }, nextPair.privateKey);
  assert.ok((await Promise.all(Array.from({ length: 30 }, () => f.validate(resource, token)))).every(Boolean)); assert.equal(f.calls.length, 2);
  assert.equal(await f.validate(resource, await sign()), null); assert.equal(f.calls.length, 2);
});
test('independent failed refresh obeys cooldown, then recovers without stale acceptance', async () => {
  let failed = false; const f = fixture(() => { if (failed) throw Error('synthetic private detail'); return Response.json({ keys: [jwk] }); });
  const token = await sign(); assert.ok(await f.validate(resource, token)); failed = true; f.advance(300000);
  assert.equal(await f.validate(resource, token), null); failed = false; f.advance(29999); assert.equal(await f.validate(resource, token), null); f.advance(1); assert.ok(await f.validate(resource, token)); assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(({url,init}) => url === IDP_JWKS && init.redirect === 'manual' && Object.keys(init.headers).join(',') === 'Accept'));
});

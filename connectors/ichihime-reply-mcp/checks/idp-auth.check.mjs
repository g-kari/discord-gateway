import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createIdpTokenValidator, IDP_ISSUER, IDP_JWKS } from '../src/idp-auth.mjs';

const key = await generateKeyPair('ES256');
const other = await generateKeyPair('ES256');
const publicJwk = { ...await exportJWK(key.publicKey), kid: 'synthetic-key-1', alg: 'ES256', use: 'sig' };
const otherJwk = { ...await exportJWK(other.publicKey), kid: 'synthetic-key-2', alg: 'ES256', use: 'sig' };
const resource = 'https://reply.test/mcp';
const seconds = Math.floor(Date.now() / 1000);
const claims = { iss: IDP_ISSUER, sub: 'synthetic-owner', aud: resource, iat: seconds, exp: seconds + 900, cid: 'synthetic-client', scope: 'discord:reply:read discord:reply:send', jti: 'synthetic-jti' };
const token = (patch = {}, header = {}, signingKey = key.privateKey) => new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid, ...header }).sign(signingKey);
function fixture(response = () => Response.json({ keys: [publicJwk] })) {
  const calls = [];
  let clock = seconds * 1000;
  const validate = createIdpTokenValidator({ now: () => clock, fetcher: async (url, init) => { calls.push({ url, init }); return response(); } });
  return { validate, calls, advance: ms => { clock += ms; } };
}
test('JWT maps only verified access claims and fetches the fixed public JWKS', async () => {
  const f = fixture();
  assert.deepEqual(await f.validate(resource, await token()), { audience: resource, expiresAt: claims.exp, userId: claims.sub, clientId: claims.cid, scope: ['discord:reply:read', 'discord:reply:send'], props: {} });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, IDP_JWKS); assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  await f.validate(resource, await token()); assert.equal(f.calls.length, 1);
});
const invalid = [
  ['wrong issuer', { iss: 'https://untrusted.test' }], ['wrong audience', { aud: 'https://other.test/mcp' }],
  ['multiple audiences', { aud: [resource, 'https://other.test/mcp'] }], ['missing audience', { aud: undefined }],
  ['missing subject', { sub: undefined }], ['empty subject', { sub: '' }], ['non-string subject', { sub: 5 }],
  ['missing client', { cid: undefined }], ['empty client', { cid: ' ' }], ['non-string client', { cid: 5 }],
  ['expired', { exp: seconds }], ['missing expiry', { exp: undefined }], ['string expiry', { exp: String(seconds + 900) }],
  ['future issued-at', { iat: seconds + 1 }], ['missing issued-at', { iat: undefined }], ['future nbf', { nbf: seconds + 1 }],
  ['too long lifetime', { exp: seconds + 901 }], ['old issued-at', { iat: seconds - 901 }], ['reversed lifetime', { exp: seconds - 1 }],
  ['missing jti', { jti: undefined }], ['empty jti', { jti: '' }],
  ['missing scope', { scope: undefined }], ['array scope', { scope: ['discord:reply:read'] }], ['empty scope', { scope: '' }],
  ['duplicate scope', { scope: 'discord:reply:read discord:reply:read' }], ['empty scope token', { scope: 'discord:reply:read  discord:reply:send' }],
  ['control scope', { scope: 'discord:reply:read\n' }], ['ID token shape', { sub: 'pairwise-sub', aud: 'client-id', cid: undefined, scope: undefined }],
  ['internal BFF shape', { aud: IDP_ISSUER, cid: undefined, scope: undefined }]
];
for (const [name, patch] of invalid) test('JWT rejects ' + name, async () => {
  const f = fixture(); assert.equal(await f.validate(resource, await token(patch)), null);
});
for (const [name, header] of [['missing kid', { kid: undefined }], ['unknown kid', { kid: 'unknown' }], ['untrusted jku', { jku: 'https://evil.test/jwks' }], ['inline jwk', { jwk: publicJwk }], ['x5u', { x5u: 'https://evil.test/key' }]]) test('JWT rejects header ' + name, async () => { const f = fixture(); assert.equal(await f.validate(resource, await token({}, header)), null); assert.ok(f.calls.length <= 1); });
test('JWT rejects invalid signature, unsupported alg and opaque token', async () => {
  const f = fixture(); assert.equal(await f.validate(resource, await token({}, {}, other.privateKey)), null);
  assert.equal(await f.validate(resource, 'opaque-token'), null);
  const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: publicJwk.kid }).sign(new Uint8Array(32));
  assert.equal(await f.validate(resource, hmac), null);
});
test('JWT rotation is bounded, refetches new kid after cooldown and drops removed key', async () => {
  let rotated = false;
  const f = fixture(() => Response.json({ keys: rotated ? [otherJwk] : [publicJwk] }));
  assert.ok(await f.validate(resource, await token())); rotated = true;
  const newToken = await token({}, { kid: otherJwk.kid }, other.privateKey);
  for (let i = 0; i < 20; i++) assert.equal(await f.validate(resource, newToken), null);
  assert.equal(f.calls.length, 1); f.advance(30000);
  assert.ok(await f.validate(resource, newToken)); assert.equal(f.calls.length, 2);
  assert.equal(await f.validate(resource, await token()), null); assert.equal(f.calls.length, 2);
});
test('JWT concurrent first requests share a single JWKS fetch', async () => {
  const f = fixture(); const t = await token(); const results = await Promise.all(Array.from({ length: 20 }, () => f.validate(resource, t)));
  assert.ok(results.every(Boolean)); assert.equal(f.calls.length, 1);
});
for (const [name, response] of [
  ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/key' } })],
  ['network failure', () => { throw Error('synthetic failure'); }], ['500', () => new Response('synthetic', { status: 500 })],
  ['wrong media', () => new Response('{}', { headers: { 'Content-Type': 'text/html' } })],
  ['malformed JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
  ['oversized', () => Response.json({ padding: 'x'.repeat(17000), keys: [publicJwk] })],
  ['no keys', () => Response.json({ keys: [] })], ['duplicate kid', () => Response.json({ keys: [publicJwk, publicJwk] })],
  ['wrong curve', () => Response.json({ keys: [{ ...publicJwk, crv: 'P-384' }] })],
  ['private key material', () => Response.json({ keys: [{ ...publicJwk, d: 'synthetic' }] })],
  ['non-signing key', () => Response.json({ keys: [{ ...publicJwk, use: 'enc' }] })]
]) test('JWT JWKS rejects ' + name + ' and throttles failures', async () => { const f = fixture(response); const t = await token(); assert.equal(await f.validate(resource, t), null); assert.equal(await f.validate(resource, t), null); assert.equal(f.calls.length, 1); });
test('JWT fails closed when cached keys expire and refresh fails', async () => {
  let failed = false; const f = fixture(() => { if (failed) throw Error('unavailable'); return Response.json({ keys: [publicJwk] }); });
  const t = await token(); assert.ok(await f.validate(resource, t)); failed = true; f.advance(300000);
  assert.equal(await f.validate(resource, t), null); assert.equal(await f.validate(resource, t), null); assert.equal(f.calls.length, 2);
});
test('JWT rejects bad resource and oversized token before key fetch', async () => { const f = fixture(); for (const r of ['http://reply.test/mcp', resource + '?q=x', resource + '#f', 'https://u:p@reply.test/mcp']) assert.equal(await f.validate(r, await token()), null); assert.equal(await f.validate(resource, 'x'.repeat(8193)), null); assert.equal(f.calls.length, 0); });

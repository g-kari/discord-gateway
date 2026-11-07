import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

// The existing owner's authorization server. Never trust token-controlled URLs.
export const IDP_ISSUER = 'https://id.0g0.xyz';
export const IDP_JWKS = IDP_ISSUER + '/.well-known/jwks.json';
const MAX_JWKS_BYTES = 16384, CACHE_MS = 300000, REFRESH_MS = 30000;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

async function readJwks(response) {
  if (!response.ok || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) throw Error('unavailable');
  if (Number(response.headers.get('Content-Length')) > MAX_JWKS_BYTES || !response.body) throw Error('unavailable');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JWKS_BYTES) throw Error('unavailable');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!data || !Array.isArray(data.keys) || !data.keys.length || data.keys.length > 8) throw Error('unavailable');
  const kids = new Set();
  for (const key of data.keys) {
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig' || typeof key.kid !== 'string' || !key.kid || key.kid.length > 128 || kids.has(key.kid) || 'd' in key || typeof key.x !== 'string' || typeof key.y !== 'string' || (key.key_ops && (!Array.isArray(key.key_ops) || key.key_ops.some(op => op !== 'verify')))) throw Error('unavailable');
    kids.add(key.kid);
  }
  return { resolver: createLocalJWKSet(data), kids };
}

// Each isolate caches public keys only. Dependencies are injectable for synthetic
// tests, not from request input or Worker configuration.
export function createIdpTokenValidator({ fetcher = fetch, now = Date.now } = {}) {
  let cache = null, pending = null, lastAttempt = -Infinity;
  async function refresh() {
    if (pending) return pending;
    if (now() - lastAttempt < REFRESH_MS) throw Error('unavailable');
    lastAttempt = now();
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetcher(IDP_JWKS, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
        const keys = await readJwks(response);
        cache = { ...keys, fetchedAt: now() };
        return cache;
      } finally { clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return async function validate(resource, token) {
    try {
      const u = new URL(resource);
      if (u.protocol !== 'https:' || u.pathname !== '/mcp' || u.search || u.hash || u.username || u.password || typeof token !== 'string' || token.length > 8192) return null;
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 128 || ['jku', 'x5u', 'jwk', 'x5c'].some(k => k in header)) return null;
      let keys = cache;
      if (!keys || now() - keys.fetchedAt >= CACHE_MS) keys = await refresh();
      if (!keys.kids.has(header.kid)) keys = await refresh();
      if (!keys.kids.has(header.kid)) return null;
      const { payload } = await jwtVerify(token, keys.resolver, {
        issuer: IDP_ISSUER, audience: resource, algorithms: ['ES256'],
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'cid', 'scope', 'jti'],
        maxTokenAge: 900, clockTolerance: 0, currentDate: new Date(now())
      });
      const seconds = now() / 1000;
      // 0g0-id resource access tokens use the raw user.id as sub and a single
      // resource aud. Its ID tokens are pairwise and lack cid/scope.
      if (payload.aud !== resource || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.iat > seconds || payload.exp <= seconds || payload.exp <= payload.iat || payload.exp - payload.iat > 900 || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 128 || typeof payload.cid !== 'string' || !payload.cid.trim() || payload.cid.length > 2048 || typeof payload.jti !== 'string' || !payload.jti.trim() || typeof payload.scope !== 'string' || !payload.scope || payload.scope.length > 4096) return null;
      const scopes = payload.scope.split(' ');
      if (scopes.length > 50 || scopes.some(s => !SCOPE.test(s)) || new Set(scopes).size !== scopes.length) return null;
      return { audience: resource, expiresAt: payload.exp, userId: payload.sub, clientId: payload.cid, scope: scopes, props: {} };
    } catch { return null; } // Never return/log the JWT, claims, or network error.
  };
}

export const validateIdpToken = createIdpTokenValidator();

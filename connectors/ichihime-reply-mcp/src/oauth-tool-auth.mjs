import { READ_SCOPE, WRITE_SCOPE, SafeError, toolError } from './core.mjs';

// SDK 2.4 serializes descriptor _meta; a top-level securitySchemes is ignored.
// Keep read-only tools usable with the endpoint's existing baseline read grant.
export function toolSecurityMetadata(scope = READ_SCOPE) {
  return { securitySchemes: [{ type: 'oauth2', scopes: scope === WRITE_SCOPE ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE] }] };
}

// Called only by send tools after the authenticated connection/scope check.
// This requests host-mediated consent; it does not grant scope or retry a send.
export function sendScopeError(error, resource) {
  const result = toolError(error);
  if (!(error instanceof SafeError) || error.code !== 'insufficient_scope') return result;
  let url;
  try { url = new URL(resource); } catch { return result; }
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash || url.href !== resource) return result;
  result._meta = { 'mcp/www_authenticate': [
    `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Discord reply send permission is required", scope="${READ_SCOPE} ${WRITE_SCOPE}"`
  ] };
  return result;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_SCOPE, WRITE_SCOPE, SafeError, toolError } from '../src/core.mjs';
import { toolSecurityMetadata, sendScopeError } from '../src/oauth-tool-auth.mjs';

const RESOURCE = 'https://reply.test/mcp';
const challenge = 'Bearer resource_metadata="https://reply.test/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Discord reply send permission is required", scope="discord:reply:read discord:reply:send"';

test('tool security metadata separates baseline read from read plus send', () => {
  assert.deepEqual(toolSecurityMetadata(), { securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE] }] });
  assert.deepEqual(toolSecurityMetadata(READ_SCOPE), toolSecurityMetadata());
  assert.deepEqual(toolSecurityMetadata(WRITE_SCOPE), { securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE, WRITE_SCOPE] }] });
  const mutated = toolSecurityMetadata(WRITE_SCOPE);
  mutated.securitySchemes[0].scopes.push('unapproved');
  assert.deepEqual(toolSecurityMetadata(WRITE_SCOPE).securitySchemes[0].scopes, [READ_SCOPE, WRITE_SCOPE]);
});

test('missing send scope returns a bounded host consent challenge, preserving the safe error', () => {
  const error = new SafeError('insufficient_scope');
  error.message = 'must never echo bearer tokens, source text or HTTP data';
  assert.deepEqual(sendScopeError(error, RESOURCE), { ...toolError(error), _meta: { 'mcp/www_authenticate': [challenge] } });
  assert.deepEqual(toolError(error), { content: [{ type: 'text', text: '{"error":"insufficient_scope"}' }], isError: true });
});

test('non-scope, plain and forged errors do not trigger consent or expose diagnostics', () => {
  for (const error of [new SafeError('access_denied'), new SafeError('source_not_verified'), new SafeError('send_not_enabled'),
    new Error('insufficient_scope token-secret'), { code: 'insufficient_scope', message: 'source-secret' }, null]) {
    assert.deepEqual(sendScopeError(error, RESOURCE), toolError(error));
    assert.equal(sendScopeError(error, RESOURCE)._meta, undefined);
  }
});

test('malformed or noncanonical resource cannot inject a challenge or expose credentials', () => {
  for (const resource of [undefined, '', 'bad', 'http://reply.test/mcp', 'https://name:secret@reply.test/mcp',
    'https://reply.test/mcp?token=secret', 'https://reply.test/mcp#source', 'https://reply.test/elsewhere',
    'https://REPLY.test/mcp', 'https://reply.test:443/mcp', 'https://reply.test/mcp\r\nInjected: value']) {
    const error = new SafeError('insufficient_scope');
    assert.deepEqual(sendScopeError(error, resource), toolError(error));
  }
});

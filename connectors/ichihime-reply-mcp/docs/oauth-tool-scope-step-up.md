# OAuth tool scope step-up

The shared reply entrypoint advertises each tool's OAuth requirements in
`_meta.securitySchemes`. Status, source verification and receipt reads require
`discord:reply:read`. Both manual and automatic sends require the complete set
`discord:reply:read discord:reply:send`.

The HTTP resource keeps its existing baseline `requiredScopes: [READ_SCOPE]`.
Workers OAuth Provider 1.2.4 publishes that baseline as protected-resource
`scopes_supported` and uses it in the initial HTTP 401 challenge. This API treats
`scopes_supported` as the minimum initial set, not an optional-scope catalogue;
setting both it and `requiredScopes` throws. Requiring send globally would
unnecessarily interrupt status, source verification and receipt access.

For an authenticated, owner/client-matched read-only connection, either send
tool returns the existing safe `insufficient_scope` tool error with
`_meta["mcp/www_authenticate"]`. Its Bearer challenge names the same resource's
`/.well-known/oauth-protected-resource/mcp` metadata, `insufficient_scope`, a
static description and the full read-plus-send requirement. Only the validated
server resource origin and fixed public scope names enter the challenge; no
source text, input IDs, OAuth token, HTTP response or secret is echoed.
The challenge is returned before the ledger is accessed, a source is looked up
or any message is dispatched. It neither creates a grant nor retries a send.

SDK 2.4.0 serializes descriptor `_meta` through `registerTool` and `tools/list`.
Its registration method discards an unsupported top-level `securitySchemes`
property. Its native `requireScopes` depends on SDK request `authInfo`; this
entrypoint instead uses the existing verified Cloudflare `ctx.auth` captured by
the callback. Keep scope enforcement there and in the ledger. Invalid tokens
remain HTTP 401, and a wrong owner/client is rejected before tool execution.
Send scope is checked before source, target, activation-gate and dedup checks.
A read-only token therefore receives the scope challenge even for inputs that
would fail those later checks. Once the required scopes are present and those
checks are reached, their failures do not become OAuth consent prompts.

## Host refresh and consent

After an authorized deployment, refresh the existing app's tool definitions
using the host's supported update flow. Do not replace an App-backed connection
with a second plugin or assume a generated plugin archive changes the installed
App's OAuth defaults. Verify all five returned descriptors in the actual host.
A host may cache tool metadata or require its own app configuration update;
synthetic MCP tests do not establish that the host will display a consent UI.

If the existing grant lacks send permission, use the host-mediated OAuth consent
flow with the user's required approval. Preserve the same client, resource,
owner, channel and permanent ledger. Do not create credentials or grants, change
permissions, enable automatic sending or perform a real Discord test merely to
exercise this challenge. Confirm `send_scope_granted` only after consent has
completed, then follow the existing activation and source-verification checks.

## Verification

`checks/oauth-tool-auth.check.mjs` tests safe challenge construction and exclusion
of unrelated errors or malformed resource URLs. The synthetic workerd suite
`checks/oauth-tool-auth.integration.mjs` covers discovery and serialized tool
metadata; read-only access; both send challenges; no dispatch or reservation
before consent; signed-token rejection; source/target failures; full-scope
synthetic sends and permanent cross-tool dedup after runtime restart. Its local
fixture disables Miniflare's implicit metadata fetch (`cf: false`). No real
OAuth grant, credential, production configuration or Discord message is used.

References:

- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
- [Update an existing plugin](https://developers.openai.com/plugins/build/app-quickstart#next-steps)
- Installed `@cloudflare/workers-oauth-provider` 1.2.4:
  `OAuthResourceServerOptions.requiredScopes` and `validateOptions`.
- Installed `@modelcontextprotocol/server` 2.4.0:
  `McpServer.registerTool` and `setToolRequestHandlers`.

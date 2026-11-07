# Shared Discord reply MCP: implementation and activation plan

This is source and synthetic verification, not permission to migrate, register a
client, expand access, enable a connection or send a real message. The existing
Gateway and dedicated v0.2 entrypoint are unchanged.

## Authentication and fixed connections

Use one HTTPS MCP resource and the existing fixed `https://id.0g0.xyz` issuer.
The reviewed ES256/JWKS adapter still validates the exact single audience,
issuer, expiry, raw owner subject, signed `cid`, and scopes. Neither an ID token,
pairwise OIDC subject, username nor an inbound event authenticates a reply.

`src/shared-worker.mjs` resolves the verified OAuth `clientId` to exactly one
row in `CONNECTION_POLICIES_JSON`. It then checks that row's raw owner subject
and `discord:reply:read`; sends also require `discord:reply:send`. Unknown
clients/owners and duplicate clients or connection IDs fail closed. A malformed
row invalidates the whole policy. Do not learn or enroll a policy from a first
JWT, event or third-party request.

Exact row fields:

- `connection_id`: immutable, unique lowercase identifier. Retain it through
  OAuth client replacement. Never recycle a retired ID for another connection.
- `client_id`: exact, verified issuer client ID, unique across all rows.
- `owner_subject`: the verified raw IdP resource access-token subject.
- `bot`: `ichihime` or `croissand`, the two names the unchanged Gateway supports.
  Receipt author IDs are fixed in server code to the public Gateway registry.
- `targets`: 1–20 verified `{guild_id, channel_id, type}` objects. Only text/news
  channel types 0/5; no duplicates. Obtain real metadata and the owner's exact
  destination approval before enabling.
- `enabled`: JSON boolean. A stopped connection can still read its own status
  and permitted receipt. Clearing targets is not a substitute for this switch.
- `ledger_mode`: `isolated-v1`, except the single original ichihime row described
  below. It is not a runtime client choice.

The tool schema remains only `source_message_id`, `channel_url`, `content`.
There is no client-selectable Bot, connection, owner, key or Gateway URL.
Status lists only the authenticated row, never all connections. Receipt access
is restricted to that row and its currently permitted target.

Two host installations sharing one OAuth client ID are indistinguishable.
They cannot receive different Bot/target policies. Use separately registered
clients if different connections need different capabilities; creating those
clients needs its own action-time approval. DCR reinstallation may change a
client ID: leave the unknown client denied until its ownership is verified and
an approved policy replacement retains the same connection ID. Do not add a
second connection ID just to recover from an unknown delivery.

## Stops, delivery and persistent deduplication

Both global `SEND_ENABLED === 'true'` and row `enabled === true` are required.
The private Durable Object re-resolves owner/client/scopes and checks its own
actual DO ID against the expected policy address. It does not trust a Bot,
policy row or ingress-selected connection supplied in a request body. It
revalidates stops, token expiry, target and binding after asynchronous hashing
and reservation, immediately before the Gateway call.

New connections use a stable connection-ID/owner namespace, independent of
client registration ID. The per-source key does not change with content,
destination or Bot, so changing them conflicts rather than evades dedup. Bot
is included in the digest. Different connections have separate ledgers and may
legitimately handle the same Discord source once each. Do not switch to another
connection to retry an uncertain attempt.

The reservation is durable before `/send`. Concurrent duplicates attempt once.
`attempting`, `unknown`, storage failure after delivery and malformed receipts
never authorize a retry. There is no automatic expiry/reset, rekey or fallback.
This is at-most-once connector attempt, not exactly-once Discord delivery. The
unchanged Gateway has its own rate-limit handling. A stop does not retract an
already accepted Discord message or cancel an in-flight Gateway request.
Cloudflare configuration propagation must complete before an activation is
reported; old in-flight versions are not an instant revocation mechanism.

All existing restrictions remain: exact allowlisted guild channel URL, no DM,
thread, mentions, attachments or control characters, one message up to 2000
UTF-16 units. This is a channel message, not a native message-reference reply.
A source ID is a dedup identifier, not proof of sender identity. Automatic
Discord-origin command execution still needs separately verified structured
sender identity and action authorization.

JWT revocation remains bounded by its <=15-minute lifetime, and JWKS cache by
5 minutes. Row removal/disable rejects requests handled with the new policy
but does not invalidate an OAuth refresh grant at the IdP. Revoking that grant
is a separate operation. The Gateway admin secret remains broader than `/send`;
no credential narrowing is claimed or performed by this change.

## Migrate the existing dedicated ichihime connection

Recommended: keep the current MCP URL, Worker, `REPLY_LEDGER` binding, DO
namespace and exported class name `ReplyLedger`. Use the new entrypoint only
after an approved migration. The new implementation deliberately exports the
shared class under the existing name and adds no destructive migration.

The one original row must use `connection_id: ichihime-legacy`,
`ledger_mode: legacy-ichihime-v1`, `bot: ichihime`, the same verified owner,
exact verified existing client, and original approved targets. Only this
reserved ID may use legacy mode, and it may not use isolated mode. The DO name
`ichihime-owner:<raw owner>` and original v1 key/digest are exactly retained.
Existing `sent`, `unknown` and `attempting` rows are read unchanged. Do not
change owner, namespace, class, reserved ID or mode to make a retry possible.
No raw production IDs or credentials are included in this public document.

Activation sequence, each consequential step requires the applicable approval:

1. Read back the actual current non-secret configuration and IdP resource/
   client metadata through an approved route. Do not infer settings from a
   deployment report. Confirm targets/types/Bot permissions and no other owner.
2. Set global and row sends off, confirm rollout, drain in-flight attempts and
   preserve the existing namespace and evidence. Record the exact old code/
   settings for a stopped rollback. Do not clear or export message data.
3. Prepare the single existing ichihime row. No new OAuth grants are needed
   merely to reuse an already verified client, but changing access/policy needs
   the required approval. Unknown clients remain denied.
4. Deploy the shared entrypoint with the same binding/class/namespace and
   global sends still off. Do not create a replacement namespace or rerun a
   creation migration against an existing one. Verify authenticated own status,
   owner/client rejection and a known receipt without making a send attempt.
5. Add each new connection only by an approved policy change, using a stable
   new connection ID and separately verified OAuth client. Gateway code and Bot
   token storage remain unchanged. OAuth registration/consent is separate.
6. After real host DCR/scope negotiation and identity checks succeed, obtain
   exact per-connection enablement and destination/message authorization.
   Enable only the required connection and perform an explicitly approved test.
   Never claim a synthetic test proves real delivery.

Rollback: keep global send off; restore the prior dedicated entrypoint and
approved stopped settings using the same namespace. Do not roll back to a
send-enabled owner-only path that accepts clients excluded by the new policy.
New isolated ledgers remain retained; do not delete them. Investigate unknown
outcomes with approved reads, not retries or namespace recreation.

## One resource: current URL versus a new URL

- Current `https://ichihime-reply.0g0.xyz/mcp`: recommended. Keeps the exact
  audience and current host configuration. The name is cosmetic; server policy
  prevents the caller from picking a Bot. Preserves the existing DO naturally.
- New generic hostname: clearer label, but requires new resource/audience and
  DNS/route/OAuth/host configuration approval. Token audiences must remain
  exact; do not accept both resources as a shortcut. Retire/stop the old entry
  before enabling the new one. Keep the same underlying Worker/DO namespace,
  or perform a separately reviewed ledger migration. A new Worker/namespace
  without legacy state is not safe.

This PR keeps one resource in either deployment. It creates neither hostname
nor client. `wrangler.shared.example.jsonc` is deliberately unconfigured with
both sends and previews off; an empty policy returns 503. It is not a command
to deploy over production or create an additional DO.

## Host compatibility and outstanding proof

The existing public IdP DCR source accepts OIDC scopes in registration metadata
only. A host submitting the Discord resource scopes there can be rejected.
Actual ChatGPT registration, both scopes, owner consent and live tool discovery
remain unverified. Do not generate a client secret or relax issuer/scope
validation to fix it. The current SDK advertises the read baseline; send scope
is enforced inside the tool, with host defaultScopes requesting read+send.

New connections are policy-only **on this MCP service** when the Gateway already
supports their Bot. Adding a third Bot would require Gateway work, and creating
or broadening an OAuth client/refresh grant is not a policy-only approval.

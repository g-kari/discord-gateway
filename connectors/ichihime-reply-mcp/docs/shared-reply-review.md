# Shared reply security verification

The final shared implementation has no unresolved high-risk finding in the
completed independent source and synthetic checks. This is not a production
activation, OAuth connection, Discord delivery, or GitHub approval.

Three initial defects were reproduced and fixed:

1. A private call to the wrong physical Durable Object could reserve in a
   different ledger. The actual DO ID must now match the resolved policy's DO.
2. Policy disablement during awaited hashing could dispatch using a stale
   enabled row. Final synchronous policy/target/stop checks now follow hashing.
3. Expiry during the same interval could dispatch with an expired principal.
   Final expiry validation occurs before the Gateway fetch with no await gap.

Eight independent unit checks passed after these fixes. The race checks assert
that the injected change occurs at the last asynchronous post-reservation hash.
Two additional real-workerd/SQLite tests use signed synthetic ES256 tokens and
verify client/Bot/target isolation, header and argument override rejection,
unknown/owner/audience/scope rejection, client replacement, Bot digest conflict,
persistent sent/unknown receipts, and wrong-DO refusal.

The primary migration test also starts the actual dedicated v0.2 bundle, stores
sent and unknown results, seeds an old-format attempting row in real SQLite,
then switches to the shared bundle under the same namespace and class. All
three states survive full runtime restarts with no repeated Gateway dispatch.

All gateways, tokens, signing keys and identifiers in these tests are synthetic.
Outbound traffic is blocked except the mocked fixed JWKS endpoint; no real
OAuth grant, deployment, credential, permission change or send is performed.
The test source is in checks/shared-policy.check.mjs,
checks/shared-independent.check.mjs, checks/shared-runtime.integration.mjs and
checks/shared-independent.integration.mjs.

Production identity, namespace and channel metadata, host OAuth/DCR behavior,
Gateway deployment contract, and exact activation permissions still require
live verification through approved routes. Shared client IDs cannot distinguish
individual installations. JWT/key-cache and migration limits are documented
in shared-reply-design.md.

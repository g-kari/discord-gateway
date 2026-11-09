import { READ_SCOPE, WRITE_SCOPE, fail, SafeError } from './core.mjs';
import { resolveConnection, validateConnectionReply, connectionIdentity, connectionLedgerName, assertSendingEnabled, deliverConnection } from './connection-policy.mjs';
import { assertAutomaticEnabled, automaticNotBefore, validateSourceInput, verifyAutomaticSource, sourceGuard } from './automatic-source.mjs';
// Exported as ReplyLedger by shared-worker.mjs so the existing DO class and
// namespace can be retained. A new namespace is NOT a safe migration.
export class SharedReplyLedger {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    try {
      const body = await request.json();
      if (!body || Object.keys(body).sort().join(',') !== 'auth,input,operation' || !['send', 'auto_send', 'receipt'].includes(body.operation)) fail('invalid_operation');
      const { operation, auth, input } = body;
      const automatic = operation === 'auto_send';
      // Re-resolve policy here; never trust a row, Bot or connection passed by ingress.
      const row = resolveConnection(auth, this.env, operation === 'receipt' ? READ_SCOPE : WRITE_SCOPE);
      const ledgerName = await connectionLedgerName(row);
      if (!this.ctx.id || !this.env.REPLY_LEDGER || this.ctx.id.toString() !== this.env.REPLY_LEDGER.idFromName(ledgerName).toString()) fail('connection_route_mismatch');
      const reply = automatic ? validateSourceInput(input, row, true) : validateConnectionReply(input, row);
      const { key, digest } = await connectionIdentity(reply, row);
      if (operation === 'receipt') {
        const saved = await this.ctx.storage.get(key);
        return Response.json(saved && saved.digest === digest ? publicRow(saved) : { status: 'not_found' });
      }
      assertSendingEnabled(row, this.env);
      if (automatic) {
        assertAutomaticEnabled(row, this.env);
        await verifyAutomaticSource(reply, row, this.env);
      }
      const reservation = await this.ctx.storage.transaction(async txn => {
        const existing = await txn.get(key);
        if (existing) return { existing };
        const saved = { digest, status: 'attempting', created_at: new Date().toISOString() };
        await txn.put(key, saved); // Never expire or reset automatically.
        return { saved };
      });
      if (reservation.existing) {
        if (reservation.existing.digest !== digest) fail('source_already_used_with_different_reply');
        return Response.json(publicRow(reservation.existing));
      }
      let saved;
      try {
        // Stop/auth checks again after the await for persistent reservation.
        const current = resolveConnection(auth, this.env, WRITE_SCOPE);
        assertSendingEnabled(current, this.env);
        if (automatic) {
          assertAutomaticEnabled(current, this.env);
          validateSourceInput(input, current, true);
        } else validateConnectionReply(input, current);
        const currentIdentity = await connectionIdentity(reply, current);
        const currentName = await connectionLedgerName(current);
        if (JSON.stringify(currentIdentity) !== JSON.stringify({ key, digest }) || this.ctx.id.toString() !== this.env.REPLY_LEDGER.idFromName(currentName).toString()) fail('policy_changed');
        const source = automatic ? await verifyAutomaticSource(reply, current, this.env) : null;
        // No await from this final policy/expiry/stop check to the Gateway fetch.
        const final = resolveConnection(auth, this.env, WRITE_SCOPE);
        if (automatic) {
          assertAutomaticEnabled(final, this.env);
          validateSourceInput(input, final, true);
          if (source.expires_at_ms <= Date.now() || source.created_at_ms < automaticNotBefore(this.env)) fail('source_not_verified');
        } else validateConnectionReply(input, final);
        assertSendingEnabled(final, this.env);
        if (binding(final) !== binding(current)) fail('policy_changed');
        const receipt = await deliverConnection(reply, final, this.env, automatic ? sourceGuard(reply) : undefined);
        saved = { ...reservation.saved, status: 'sent', receipt };
      } catch {
        saved = { ...reservation.saved, status: 'unknown', retry_allowed: false };
      }
      await this.ctx.storage.put(key, saved);
      return Response.json(publicRow(saved));
    } catch (error) {
      return Response.json({ error: error instanceof SafeError ? error.code : 'internal_error' }, { status: 400 });
    }
  }
}
function publicRow(row) {
  if (row.status === 'sent') return { status: 'sent', retry_allowed: false, ...row.receipt };
  return { status: row.status === 'attempting' ? 'unknown_or_inflight' : 'unknown', retry_allowed: false };
}

function binding(row) { return JSON.stringify([row.connection_id, row.owner_subject, row.client_id, row.bot, row.ledger_mode]); }

import { assertOwner, validateReply, identity, deliver, READ_SCOPE, WRITE_SCOPE, fail, SafeError } from './core.mjs';
export class ReplyLedger {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    try {
      // This class is reachable only through a private Durable Object binding.
      const { operation, auth, input } = await request.json();
      assertOwner(auth, this.env, operation === 'send' ? WRITE_SCOPE : READ_SCOPE);
      const reply = validateReply(input, this.env);
      const { key, digest } = await identity(reply, this.env.OWNER_SUBJECT);
      if (operation === 'receipt') {
        const row = await this.ctx.storage.get(key);
        return Response.json(row && row.digest === digest ? publicRow(row) : { status: 'not_found' });
      }
      if (operation !== 'send') fail('invalid_operation');
      if (this.env.SEND_ENABLED !== 'true' || !this.env.GATEWAY_ADMIN_KEY || !this.env.GATEWAY_SERVICE) fail('send_not_enabled');
      const reservation = await this.ctx.storage.transaction(async txn => {
        const existing = await txn.get(key);
        if (existing) return { existing };
        const row = { digest, status: 'attempting', created_at: new Date().toISOString() };
        await txn.put(key, row); // Persist before any side effect. Never expire/reset automatically.
        return { row };
      });
      if (reservation.existing) {
        if (reservation.existing.digest !== digest) fail('source_already_used_with_different_reply');
        return Response.json(publicRow(reservation.existing));
      }
      let row;
      try {
        const receipt = await deliver(reply, this.env);
        row = { ...reservation.row, status: 'sent', receipt };
      } catch {
        // A timeout/error can happen after Discord accepted the message.
        // Do not echo the response, credentials, stack trace, or reply content.
        row = { ...reservation.row, status: 'unknown', retry_allowed: false };
      }
      await this.ctx.storage.put(key, row);
      return Response.json(publicRow(row));
    } catch (error) {
      return Response.json({ error: error instanceof SafeError ? error.code : 'internal_error' }, { status: 400 });
    }
  }
}
function publicRow(row) {
  if (row.status === 'sent') return { status: 'sent', retry_allowed: false, ...row.receipt };
  // Also covers a crash/restart while status was attempting. Never re-send.
  return { status: row.status === 'attempting' ? 'unknown_or_inflight' : 'unknown', retry_allowed: false };
}

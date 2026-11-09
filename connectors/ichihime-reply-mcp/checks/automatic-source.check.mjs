import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_SCOPE, WRITE_SCOPE, sha256 } from '../src/core.mjs';
import { connectionLedgerName, validateConnectionReply, connectionIdentity } from '../src/connection-policy.mjs';
import { assertAutomaticEnabled, validateSourceInput, verifyAutomaticSource } from '../src/automatic-source.mjs';
import { SharedReplyLedger } from '../src/shared-ledger.mjs';

const G = '111111111111111111', C = '222222222222222222';
const row = { connection_id: 'ichihime-legacy', client_id: 'synthetic-client', owner_subject: 'synthetic-owner', bot: 'ichihime',
  targets: [{ guild_id: G, channel_id: C, type: 0 }], enabled: true, ledger_mode: 'legacy-ichihime-v1' };
const auth = { userId: row.owner_subject, clientId: row.client_id, scope: [READ_SCOPE, WRITE_SCOPE], expiresAt: Date.now() / 1000 + 600 };
const input = { source_message_id: '1569099999999999999', channel_url: `https://discord.com/channels/${G}/${C}`,
  content: 'Synthetic routine reply', source_text_sha256: 'a'.repeat(64) };
const plain = ({ source_text_sha256, ...reply }) => reply;
const env = (patch = {}) => ({ CONNECTION_POLICIES_JSON: JSON.stringify([row]), SEND_ENABLED: 'true', AUTO_REPLY_ENABLED: 'true',
  AUTO_REPLY_NOT_BEFORE: new Date(Date.now() - 60000).toISOString(), GATEWAY_ADMIN_KEY: 'synthetic-not-a-secret', ...patch });
function proof(patch = {}) { const created = Date.now() - 10000; return { verified: true, owner_verified: true, self_mentioned: true, bot: 'ichihime',
  source_message_id: input.source_message_id, guild_id: G, channel_id: C, source_text_sha256: input.source_text_sha256,
  created_at_ms: created, received_at_ms: created + 1000, expires_at_ms: created + 86400000, reply_context: 'none', ...patch }; }
class Storage {
  constructor() { this.data = new Map(); this.chain = Promise.resolve(); }
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async transaction(fn) { const last = this.chain; let done; this.chain = new Promise(r => done = r); await last; try { return await fn(this); } finally { done(); } }
}
async function rig(patch = {}, source = () => proof()) {
  const calls = [], storage = new Storage();
  const e = env({ REPLY_LEDGER: { idFromName: n => ({ toString: () => n }) }, GATEWAY_SERVICE: { fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Bearer synthetic-not-a-secret');
    if (url.endsWith('/reply-source')) return Response.json(await source(calls, e));
    assert.equal(url, 'https://gateway.internal/send');
    return Response.json({ id: '1569199999999999999', channel_id: C, author: { id: '1568548424519913482' } });
  } }, ...patch });
  const ctx = { storage, id: { toString: () => 'ichihime-owner:synthetic-owner' } };
  return { e, calls, storage, ctx, ledger: new SharedReplyLedger(ctx, e) };
}
async function invoke(r, operation = 'auto_send', value = input, identity = auth) {
  const res = await r.ledger.fetch(new Request('https://ledger.internal/', { method: 'POST', body: JSON.stringify({ operation, input: value, auth: identity }) }));
  return res.json();
}
const sends = r => r.calls.filter(c => c.url.endsWith('/send'));

test('automatic source hash uses exact UTF-8 bytes; header/newline changes differ', async () => {
  const text = `[discord channel:${C} guild:${G} author:synthetic]\n一姫、こんにちは`;
  assert.notEqual(await sha256(text), await sha256(text + '\n'));
  assert.notEqual(await sha256(text), await sha256(text.replace('\n', '\r\n')));
});
test('auto reply keeps the legacy manual address, key and digest', async () => {
  const reply = validateSourceInput(input, row, true);
  assert.equal(await connectionLedgerName(row), 'ichihime-owner:synthetic-owner');
  assert.deepEqual(await connectionIdentity(reply, row), await connectionIdentity(validateConnectionReply(plain(input), row), row));
});
for (const [name, change] of Object.entries({ otherConnection: { connection_id: 'other' }, bot: { bot: 'croissand' },
  mode: { ledger_mode: 'isolated-v1' },
  multipleTargets: { targets: [...row.targets, { ...row.targets[0], channel_id: '222222222222222223' }] },
  news: { targets: [{ ...row.targets[0], type: 5 }] } })) {
  test(`automatic route rejects ${name}`, () => assert.throws(() => validateSourceInput(input, { ...row, ...change }, true), e => e.code === 'automatic_reply_not_configured'));
}
test('source arguments are exact and cannot supply identity or endpoint', () => {
  for (const patch of [{ source_text_sha256: 'A'.repeat(64) }, { source_text_sha256: 'a'.repeat(63) }, { author_id: 'owner' },
    { bot: 'ichihime' }, { source: proof() }, { channel_url: input.channel_url + '/123' }]) assert.throws(() => validateSourceInput({ ...input, ...patch }, row, true));
  assert.throws(() => validateSourceInput(input, row));
});
for (const [name, patch] of Object.entries({ global: { SEND_ENABLED: 'false' }, automatic: { AUTO_REPLY_ENABLED: 'false' },
  connection: { CONNECTION_POLICIES_JSON: JSON.stringify([{ ...row, enabled: false }]) },
  missingCutoff: { AUTO_REPLY_NOT_BEFORE: undefined }, malformedCutoff: { AUTO_REPLY_NOT_BEFORE: 'invalid' },
  zeroCutoff: { AUTO_REPLY_NOT_BEFORE: '0' }, yearOnlyCutoff: { AUTO_REPLY_NOT_BEFORE: '2020' },
  invalidDateCutoff: { AUTO_REPLY_NOT_BEFORE: '2026-02-30T00:00:00.000Z' },
  nonUtcCutoff: { AUTO_REPLY_NOT_BEFORE: '2026-01-01T09:00:00.000+09:00' },
  futureCutoff: { AUTO_REPLY_NOT_BEFORE: '2999-01-01T00:00:00Z' } })) {
  test(`automatic gate ${name} blocks before source lookup/reservation`, async () => {
    const r = await rig(patch); assert.ok((await invoke(r)).error); assert.equal(r.calls.length, 0); assert.equal(r.storage.data.size, 0);
  });
}
test('read verification works while sends are stopped; still restricted to the fixed source', async () => {
  const r = await rig({ SEND_ENABLED: 'false', AUTO_REPLY_ENABLED: 'false' });
  const reply = validateSourceInput(input, row, true); const result = await verifyAutomaticSource(reply, row, r.e);
  assert.equal(result.verified, true); assert.equal(result.owner_verified, true); assert.equal(sends(r).length, 0);
  assert.throws(() => assertAutomaticEnabled(row, r.e));
});
for (const [name, patch] of Object.entries({ unverified: { verified: false }, wrongOwner: { owner_verified: false }, bot: { bot: 'croissand' },
  noSelfMention: { self_mentioned: false }, missingSelfMention: { self_mentioned: undefined },
  source: { source_message_id: '1569099999999999998' }, guild: { guild_id: '111111111111111112' },
  channel: { channel_id: '222222222222222223' }, hash: { source_text_sha256: 'b'.repeat(64) },
  otherRecipient: { reply_context: 'other' }, unknownRecipient: { reply_context: 'unknown' }, absentContext: { reply_context: undefined },
  beforeActivation: { created_at_ms: Date.now() - 120000 }, expired: { expires_at_ms: Date.now() - 1 },
  future: { created_at_ms: Date.now() + 600000 }, malformedTime: { received_at_ms: 'now' },
  extendedLifetime: { expires_at_ms: Date.now() + 2 * 86400000 } })) {
  test(`source ${name} cannot reserve or send`, async () => {
    const r = await rig({}, () => proof(patch)); assert.equal((await invoke(r)).error, 'source_not_verified');
    assert.equal(r.storage.data.size, 0); assert.equal(sends(r).length, 0);
  });
}
test('source failure/redirect/oversized proof fail closed before reservation', async () => {
  for (const response of [() => new Response('', { status: 302 }), () => Response.json({ text: 'x'.repeat(5000) }), () => { throw Error('synthetic'); }]) {
    const r = await rig({ GATEWAY_SERVICE: { fetch: response } }); assert.equal((await invoke(r)).error, 'source_not_verified'); assert.equal(r.storage.data.size, 0);
  }
});
test('automatic sender rechecks source and passes the guard to Gateway; manual receipt shares result', async () => {
  const r = await rig(); const sent = await invoke(r); assert.equal(sent.status, 'sent');
  assert.equal(r.calls.filter(c => c.url.endsWith('/reply-source')).length, 2); assert.equal(sends(r).length, 1);
  assert.deepEqual(sends(r)[0].body.reply_source, { source_message_id: input.source_message_id, guild_id: G, channel_id: C, source_text_sha256: input.source_text_sha256 });
  assert.deepEqual(await invoke(r, 'receipt', plain(input)), sent);
  assert.deepEqual(await invoke(r, 'send', plain(input)), sent); assert.equal(sends(r).length, 1);
  assert.equal((await invoke(r, 'send', { ...plain(input), content: 'changed' })).error, 'source_already_used_with_different_reply');
});
test('a preexisting manual reservation also suppresses automatic sends', async () => {
  const r = await rig(); assert.equal((await invoke(r, 'send', plain(input))).status, 'sent');
  assert.equal((await invoke(r)).status, 'sent'); assert.equal(sends(r).length, 1);
});
test('read-only scope and wrong owner/client cannot use automatic send', async () => {
  const r = await rig(); for (const a of [{ ...auth, scope: [READ_SCOPE] }, { ...auth, userId: 'other' }, { ...auth, clientId: 'other' }]) assert.ok((await invoke(r, 'auto_send', input, a)).error);
  assert.equal(r.calls.length, 0); assert.equal(r.storage.data.size, 0);
});
test('revocation after reservation marks unknown, does not send and cannot use manual fallback', async () => {
  const r = await rig({}, calls => calls.length === 1 ? proof() : { verified: false });
  assert.equal((await invoke(r)).status, 'unknown'); assert.equal(sends(r).length, 0);
  assert.equal((await invoke(r, 'send', plain(input))).status, 'unknown'); assert.equal(sends(r).length, 0);
});
test('stop/cutoff change while verifying again never starts send', async () => {
  for (const mutate of [e => { e.AUTO_REPLY_ENABLED = 'false'; }, e => { e.AUTO_REPLY_NOT_BEFORE = new Date().toISOString(); },
    e => { e.SEND_ENABLED = 'false'; }, e => { e.CONNECTION_POLICIES_JSON = JSON.stringify([{ ...row, enabled: false }]); }]) {
    const r = await rig({}, (calls, e) => { if (calls.length === 2) mutate(e); return proof(); });
    assert.equal((await invoke(r)).status, 'unknown'); assert.equal(sends(r).length, 0);
  }
});
test('token expiry while verifying is rechecked before delivery', async () => {
  const r = await rig({}, async () => { await new Promise(resolve => setTimeout(resolve, 40)); return proof(); });
  const expiring = { ...auth, expiresAt: Date.now() / 1000 + 0.02 };
  assert.equal((await invoke(r, 'auto_send', input, expiring)).status, 'unknown');
  assert.equal(sends(r).length, 0);
});
test('simultaneous automatic attempts make one Gateway send and preserve unknown on errors', async () => {
  const r = await rig(); const results = await Promise.all([invoke(r), invoke(r)]);
  assert.ok(results.some(x => x.status === 'sent')); assert.equal(sends(r).length, 1);
  const u = await rig(); const fetch = u.e.GATEWAY_SERVICE.fetch;
  u.e.GATEWAY_SERVICE.fetch = (url, init) => url.endsWith('/send') ? Promise.reject(new Error('uncertain synthetic delivery')) : fetch(url, init);
  assert.equal((await invoke(u)).status, 'unknown');
  assert.equal((await invoke(u, 'send', plain(input))).status, 'unknown');
  assert.equal((await invoke(u, 'receipt', plain(input))).status, 'unknown');
});

// Local synthetic Gateway events, real DO SQLite, and mocked Discord REST.
// No production service, credentials, or messages are used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

const OWNER = "333933401314951168";
const BOT = "1568548424519913482";
const GUILD = "333444555666777888";
const CHANNEL = "222333444555666777";
const TARGET = JSON.stringify({ guild_id: GUILD, channel_id: CHANNEL, type: 0 });
const ADMIN = "synthetic-source-admin";
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://gateway.test";
let serial = 0n;
function snowflake(at = Date.now() - 1000) {
  return (((BigInt(at) - 1420070400000n) << 22n) + ++serial).toString();
}
function message(patch = {}) {
  return {
    id: snowflake(), guild_id: GUILD, channel_id: CHANNEL, content: `<@${BOT}> 一姫、確認して`,
    author: { id: OWNER, username: "synthetic-owner", bot: false },
    mentions: [{ id: BOT }], mention_roles: [], mention_everyone: false, ...patch,
  };
}
function sourceFor(m, text) {
  return {
    bot: "ichihime", source_message_id: m.id, guild_id: m.guild_id, channel_id: m.channel_id,
    source_text_sha256: createHash("sha256").update(text ??
      `[discord channel:${m.channel_id} guild:${m.guild_id} author:${m.author.username || "unknown"}]\n` +
      m.content.replace(new RegExp(`<@!?${BOT}>`, "g"), "").trim(), "utf8").digest("hex"),
  };
}
function guardFor(m) {
  const { bot, ...guard } = sourceFor(m);
  return guard;
}

const production = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const fixture = production.replace("export default {", "const productionWorker = {") + `
export class TestGateway extends Gateway {
  async scheduleAlarmLocked() {}
  async recordReplySourceEvent(bot, botUserId, payload, actions, now) {
    return super.recordReplySourceEvent(bot, botUserId, payload, actions, this.testNow ?? now);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/test/event') {
      const { event, bot = 'ichihime', botUserId = '${BOT}', now } = await request.json();
      const ws = {};
      this._sockets[bot] = { ws };
      this.saveState({ ...this.loadState(bot), botUserId }, bot);
      this.testNow = now;
      try { await this.handleSocketMessage(bot, ws, JSON.stringify(event)); }
      finally { this.testNow = undefined; }
      return new Response('ok');
    }
    if (path === '/test/config') {
      const { value } = await request.json();
      if (value === undefined) delete this.env.AUTO_REPLY_TARGET_JSON;
      else this.env.AUTO_REPLY_TARGET_JSON = value;
      return new Response('ok');
    }
    if (path === '/test/rows') return Response.json(this.ctx.storage.sql.exec('SELECT * FROM reply_sources').toArray());
    if (path === '/test/verify-at') {
      const { body, now } = await request.json();
      return this.runLocked(() => Response.json(this.verifyReplySource(body, now)));
    }
    if (path === '/test/expire') {
      const { id } = await request.json();
      this.ctx.storage.sql.exec('UPDATE reply_sources SET expires_at_ms = ? WHERE source_message_id = ?', Date.now() - 1, id);
      return new Response('ok');
    }
    if (path === '/test/legacy-schema') {
      this.ctx.storage.sql.exec('ALTER TABLE reply_sources DROP COLUMN self_mentioned');
      this.migrateReplySourceMentions();
      this.migrateReplySourceMentions();
      return Response.json(this.ctx.storage.sql.exec('PRAGMA table_info(reply_sources)').toArray());
    }
    if (path === '/test/forced-forward') {
      const { message, request: forwardRequest } = await request.json();
      await this.runLocked(() => this.recordReplySourceEvent('ichihime', '${BOT}',
        { op: 0, t: 'MESSAGE_CREATE', d: message }, [{ type: 'forward', request: forwardRequest }], Date.now()));
      return new Response('ok');
    }
    return super.fetch(request);
  }
}
export default productionWorker;`;

let mf, stub;
const sends = [];
let onSend;
before(async () => {
  mf = new Miniflare({
    modules: true, script: fixture, compatibilityDate: "2025-11-01",
    durableObjects: { GATEWAY: { className: "TestGateway", useSQLite: true } },
    bindings: { AUTO_REPLY_TARGET_JSON: TARGET, ADMIN_KEY: ADMIN, DISCORD_BOT_TOKEN: "synthetic-c", DISCORD_BOT_TOKEN_ICHICHIME: "synthetic-i" },
    outboundService: async (request) => {
      assert.match(request.url, /^https:\/\/discord\.com\/api\/v10\/channels\/\d+\/messages$/);
      const record = { url: request.url, body: await request.json(), authorization: request.headers.get("Authorization") };
      sends.push(record);
      return onSend ? onSend(record) : Response.json({ id: `synthetic-${sends.length}` }, { status: 201 });
    },
  });
  const ns = await mf.getDurableObjectNamespace("GATEWAY");
  stub = ns.get(ns.idFromName("global"));
});
after(async () => { await mf?.dispose(); });

async function event(t, d, options = {}) {
  const response = await stub.fetch("https://internal/test/event", {
    method: "POST", body: JSON.stringify({ event: { op: 0, t, d }, ...options }),
  });
  assert.equal(response.status, 200, await response.text());
}
async function post(path, body, key = ADMIN) {
  const response = await mf.dispatchFetch(ORIGIN + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function verify(m, patch = {}) { return post("/reply-source", { ...sourceFor(m), ...patch }); }
async function rows() { return (await stub.fetch("https://internal/test/rows")).json(); }
async function guardedSend(m, patch = {}) {
  return post("/send", { bot: "ichihime", channel_id: CHANNEL, content: "Synthetic reply", reply_source: guardFor(m), ...patch });
}
async function setTarget(value) {
  const response = await stub.fetch("https://internal/test/config", { method: "POST", body: JSON.stringify({ value }) });
  assert.equal(response.status, 200);
}
function reference(authorId = BOT) {
  const id = snowflake();
  return {
    message_reference: { type: 0, message_id: id, guild_id: GUILD, channel_id: CHANNEL },
    referenced_message: { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: authorId }, content: "reference text never persisted" },
  };
}

test("target config: absent/malformed/non-type-0/extra keys fail closed for recording, lookup and sending", async () => {
  const existing = message();
  await event("MESSAGE_CREATE", existing);
  const count = sends.length;
  const obj = { guild_id: GUILD, channel_id: CHANNEL, type: 0 };
  const invalid = [undefined, "", "{", "null", "[]", "{}", obj,
    ...[
      { ...obj, type: 11 }, { ...obj, type: 12 }, { ...obj, type: "0" },
      { ...obj, type: undefined }, { ...obj, guild_id: undefined }, { ...obj, channel_id: undefined },
      { ...obj, extra: true }, { ...obj, guild_id: 123 }, { ...obj, channel_id: "not-a-snowflake" },
    ].map((value) => JSON.stringify(value)),
  ];
  try {
    for (const value of invalid) {
      await setTarget(value);
      const m = message();
      await event("MESSAGE_CREATE", m);
      assert.ok(!(await rows()).some((row) => row.source_message_id === m.id), JSON.stringify(value));
      assert.deepEqual((await verify(existing)).body, { verified: false }, JSON.stringify(value));
      assert.equal((await guardedSend(existing)).status, 403);
    }
    assert.equal(sends.length, count);
  } finally { await setTarget(TARGET); }
  assert.equal((await verify(existing)).body.verified, true);
});

test("target config: changing the single allowlisted target rejects previously observed sources", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  try {
    await setTarget(JSON.stringify({ guild_id: GUILD, channel_id: "222333444555666778", type: 0 }));
    assert.deepEqual((await verify(m)).body, { verified: false });
    assert.equal((await guardedSend(m)).status, 403);
    const other = message();
    await event("MESSAGE_CREATE", other);
    assert.ok(!(await rows()).some((row) => row.source_message_id === other.id));
    assert.equal(sends.length, count);
  } finally { await setTarget(TARGET); }
});

test("reply context: no reference and a verified same-channel self reference remain sendable", async () => {
  for (const fields of [{}, reference(), (() => {
    const value = reference();
    delete value.message_reference.type;
    delete value.message_reference.guild_id;
    delete value.referenced_message.guild_id;
    return value;
  })()]) {
    const m = message(fields);
    await event("MESSAGE_CREATE", m);
    const result = await verify(m);
    assert.equal(result.body.verified, true);
    assert.equal(result.body.reply_context, Object.hasOwn(fields, "message_reference") ? "self" : "none");
    assert.equal((await guardedSend(m)).status, 201);
    assert.ok(!JSON.stringify((await rows()).find((row) => row.source_message_id === m.id)).includes("reference text"));
  }
});

test("reply context: other authors are attested as other and rejected even alongside an explicit self mention", async () => {
  const count = sends.length;
  for (const authorId of [OWNER, "123456789012345678", "1568508479293890673"]) {
    for (const selfToken of [`<@${BOT}>`, `<@!${BOT}>`]) {
      const m = message({ ...reference(authorId), content: `${selfToken} 確認して`, mentions: [{ id: BOT }] });
      await event("MESSAGE_CREATE", m);
      const result = await verify(m);
      assert.equal(result.body.verified, true);
      assert.equal(result.body.reply_context, "other");
      assert.equal((await guardedSend(m)).status, 403);
    }
  }
  assert.equal(sends.length, count);
});

test("reply context: missing/deleted/malformed/cross-channel/forward references attest unknown and cannot send", async () => {
  const patches = [
    () => ({ message_reference: null }),
    () => ({ message_reference: {} }),
    () => ({ message_reference: [] }),
    (r) => ({ ...r, referenced_message: undefined }),
    (r) => ({ ...r, referenced_message: null }),
    (r) => ({ ...r, referenced_message: [] }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, author: undefined } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, author: { id: 123 } } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, author: { id: "not-an-id" } } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, type: 1 } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, type: null } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, channel_id: undefined } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, channel_id: "222333444555666778" } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, guild_id: "333444555666777889" } }),
    (r) => ({ ...r, message_reference: { ...r.message_reference, message_id: undefined } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, id: snowflake() } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, channel_id: undefined } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, channel_id: "222333444555666778" } }),
    (r) => ({ ...r, referenced_message: { ...r.referenced_message, guild_id: "333444555666777889" } }),
  ];
  const count = sends.length;
  for (const patch of patches) {
    const m = message(patch(reference()));
    await event("MESSAGE_CREATE", m);
    const result = await verify(m);
    assert.equal(result.body.verified, true, JSON.stringify(m.message_reference));
    assert.equal(result.body.reply_context, "unknown", JSON.stringify(m));
    assert.equal((await guardedSend(m)).status, 403);
  }
  assert.equal(sends.length, count);
});

test("reply context: replay cannot replace an other/unknown source context with a sendable one", async () => {
  const count = sends.length;
  for (const fields of [reference(OWNER), { message_reference: null }]) {
    const m = message(fields);
    await event("MESSAGE_CREATE", m);
    const original = (await verify(m)).body;
    const noReference = { ...m };
    delete noReference.message_reference;
    delete noReference.referenced_message;
    await event("MESSAGE_CREATE", noReference);
    await event("MESSAGE_CREATE", { ...m, ...reference() });
    assert.deepEqual((await verify(m)).body, original);
    assert.equal((await guardedSend(m)).status, 403);
  }
  assert.equal(sends.length, count);
});

test("source: owner actual self mentions record exact full-text SHA-256 without body or username", async () => {
  for (const content of ["こんにちは", "一姫さん、確認して", "Hermesの状態を調べて", `<@${BOT}> 確認して`, "é と e\u0301\n改行を保つ"]) {
    const m = message({ content: `<@${BOT}> ${content}`, mentions: [{ id: BOT }] });
    await event("MESSAGE_CREATE", m);
    const result = await verify(m);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.equal(result.body.verified, true, content);
    assert.equal(result.body.owner_verified, true);
    assert.equal(result.body.self_mentioned, true);
    assert.equal(result.body.reply_context, "none");
    assert.equal(result.body.source_text_sha256, sourceFor(m).source_text_sha256);
    assert.equal(result.body.expires_at_ms, result.body.created_at_ms + DAY);
    const row = (await rows()).find((row) => row.source_message_id === m.id);
    assert.deepEqual(Object.keys(row).sort(), ["source_message_id", "bot", "bot_user_id", "guild_id", "channel_id", "owner_verified", "self_mentioned", "source_text_sha256", "reply_context", "created_at_ms", "received_at_ms", "expires_at_ms", "revoked"].sort());
    assert.ok(!JSON.stringify(row).includes("synthetic-owner"));
    assert.equal(row.bot_user_id, BOT);
  }
});

test("source: names/plain text/literal mentions with absent or empty metadata cannot authorize automatic sends", async () => {
  const count = sends.length;
  const cases = [
    ...["こんにちは", "一姫、確認して", "風見一姫さん", "Hermesの状態を調べて"].map((content) => ({ content, mentions: [] })),
    ...[undefined, [], null, {}, [{ id: "1568508479293890673" }]].flatMap((mentions) => [
      { content: `<@${BOT}> 確認して`, mentions },
      { content: `<@!${BOT}> 確認して`, mentions },
      { content: `\`<@${BOT}>\` は記法です`, mentions },
    ]),
  ];
  for (const patch of cases) {
    const m = message(patch);
    await event("MESSAGE_CREATE", m);
    assert.ok(!(await rows()).some((row) => row.source_message_id === m.id));
    assert.deepEqual((await verify(m)).body, { verified: false });
    assert.equal((await guardedSend(m)).status, 403);
  }
  assert.equal(sends.length, count);
});

test("source: the recording boundary independently requires a real mention even if a forward action exists", async () => {
  for (const mentions of [undefined, [], null]) {
    const m = message({ mentions });
    const response = await stub.fetch("https://internal/test/forced-forward", {
      method: "POST", body: JSON.stringify({ message: m,
        request: { text: "synthetic forced forward", topic: "discord", request_id: `discord-${m.id}` } }),
    });
    assert.equal(response.status, 200);
    assert.ok(!(await rows()).some((row) => row.source_message_id === m.id));
  }
});

test("source: forwarded bot/other human/DM/other channel/guild/Croissand are never automatic sources", async () => {
  const cases = [
    [message({ author: { id: OWNER, bot: true } })],
    [message({ author: { id: BOT, bot: true } })],
    [message({ author: { id: "1568508479293890673", bot: true }, content: `<@${BOT}> bot ping`, mentions: [{ id: BOT }] })],
    [message({ author: { id: "123456789012345678", username: "other" }, content: `<@${BOT}> human ping`, mentions: [{ id: BOT }] })],
    [message({ guild_id: undefined })],
    [message({ channel_type: 1 })],
    [message({ channel_type: 3 })],
    [message({ channel_type: 11 })],
    [message({ channel_type: 12 })],
    [message({ channel_id: "222333444555666778" })],
    [message({ guild_id: "333444555666777889" })],
    [message({ webhook_id: "123456789012345678" })],
    [message(), { bot: "croissand", botUserId: "1568508479293890673" }],
    [message(), { botUserId: "1568508479293890673" }],
    [message({ content: `<@${BOT}>`, mentions: [{ id: BOT }] })],
  ];
  for (const [m, options] of cases) {
    await event("MESSAGE_CREATE", m, options);
    assert.ok(!(await rows()).some((row) => row.source_message_id === m.id), JSON.stringify(m));
  }
});

test("source: actual mentions addressed only to others, roles or everyone remain excluded", async () => {
  for (const patch of [
    { content: "<@1568508479293890673> hi", mentions: [{ id: "1568508479293890673" }] },
    { content: "<@123456789012345678> hi", mentions: [{ id: "123456789012345678" }] },
    { content: "<@&123456789012345678> hi", mentions: [], mention_roles: ["123456789012345678"] },
    { content: "@everyone hi", mentions: [], mention_everyone: true },
  ]) {
    const m = message(patch);
    await event("MESSAGE_CREATE", m);
    assert.deepEqual((await verify(m)).body, { verified: false });
  }
});

test("source: hash, ID, channel and guild mismatch return the same negative result", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  for (const patch of [
    { source_text_sha256: "0".repeat(64) }, { source_message_id: snowflake() },
    { guild_id: "333444555666777889" }, { channel_id: "222333444555666778" },
  ]) {
    const result = await verify(m, patch);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { verified: false });
  }
});

test("source: strict request keys reject caller author/metadata, malformed hashes and snowflakes", async () => {
  const good = sourceFor(message());
  for (const body of [
    null, [], {}, { ...good, author_id: OWNER }, { ...good, owner_verified: true }, { ...good, self_mentioned: true },
    { ...good, bot: "croissand" }, { ...good, source_text_sha256: "A".repeat(64) },
    { ...good, source_text_sha256: "0".repeat(63) },
    ...["00123456789012345678", "18446744073709551616", "-1", 123, "not-an-id"].map((id) => ({ ...good, source_message_id: id })),
  ]) {
    assert.equal((await post("/reply-source", body)).status, 400, JSON.stringify(body));
  }
  const result = await mf.dispatchFetch(ORIGIN + "/reply-source", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` }, body: "{" });
  assert.equal(result.status, 400);
});

test("source: admin auth gates every lookup and no internal DO route is public", async () => {
  const good = sourceFor(message());
  for (const key of [null, "wrong-key"]) assert.equal((await post("/reply-source", good, key)).status, 401);
  const headerAuth = await mf.dispatchFetch(ORIGIN + "/reply-source", {
    method: "POST", headers: { "X-Trigger-Key": ADMIN }, body: JSON.stringify(good),
  });
  assert.equal(headerAuth.status, 200);
  for (const path of ["/internal/reply-source", "/internal/reply-send", "/test/event"]) {
    assert.equal((await post(path, good)).status, 404);
  }
});

test("source: original snowflake age limits reject expired and >=5-minute future events", async () => {
  const now = Date.now();
  for (const offset of [-DAY - 1, -DAY, 5 * 60 * 1000, 5 * 60 * 1000 + 1]) {
    const m = message({ id: snowflake(now + offset) });
    await event("MESSAGE_CREATE", m, { now });
    assert.ok(!(await rows()).some((row) => row.source_message_id === m.id), String(offset));
  }
  const m = message({ id: snowflake(now + 5 * 60 * 1000 - 1) });
  await event("MESSAGE_CREATE", m, { now });
  assert.equal((await verify(m)).body.verified, true);
});

test("source: Resume replay cannot extend first receipt/expiry or replace the original digest", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const original = (await verify(m)).body;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await event("MESSAGE_CREATE", m);
  await event("MESSAGE_CREATE", { ...m, content: `<@${BOT}> replacement body` });
  assert.deepEqual((await verify(m)).body, original);
  assert.deepEqual((await verify({ ...m, content: `<@${BOT}> replacement body` })).body, { verified: false });
});

test("source: validity ends at original creation +24h; cleanup cannot make a replay fresh", async () => {
  const now = Date.now();
  const m = message({ id: snowflake(now - DAY + 10000) });
  await event("MESSAGE_CREATE", m, { now });
  const original = (await verify(m)).body;
  assert.equal(original.verified, true);
  const result = await stub.fetch("https://internal/test/verify-at", {
    method: "POST", body: JSON.stringify({ body: sourceFor(m), now: original.expires_at_ms }),
  });
  assert.deepEqual(await result.json(), { verified: false });
  await event("MESSAGE_CREATE", m, { now: original.expires_at_ms + 1 });
  assert.ok(!(await rows()).some((row) => row.source_message_id === m.id));
});

test("source: partial update, delete and bulk delete revoke sources and late CREATEs stay revoked", async () => {
  for (const type of ["MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]) {
    for (const lateCreate of [false, true]) {
      const m = message();
      if (!lateCreate) await event("MESSAGE_CREATE", m);
      const payload = { channel_id: CHANNEL, ...(type === "MESSAGE_DELETE_BULK" ? { ids: [m.id] } : { id: m.id }) };
      // No author/body/guild is required for partial revocation events.
      await event(type, payload);
      await event("MESSAGE_CREATE", m);
      assert.deepEqual((await verify(m)).body, { verified: false }, `${type}: ${lateCreate}`);
      assert.equal((await rows()).find((row) => row.source_message_id === m.id).revoked, 1);
    }
  }
});

test("source: other channel/guild/bot update events cannot revoke this source", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  await event("MESSAGE_DELETE", { id: m.id, channel_id: "222333444555666778", guild_id: GUILD });
  await event("MESSAGE_UPDATE", { id: m.id, channel_id: CHANNEL, guild_id: "333444555666777889" });
  await event("MESSAGE_DELETE", { id: m.id, channel_id: CHANNEL }, { bot: "croissand", botUserId: "1568508479293890673" });
  assert.equal((await verify(m)).body.verified, true);
});

test("send guard: invalid, absent, expired, revoked or mismatched sources cause zero Discord fetches", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  const guard = guardFor(m);
  for (const patch of [
    { reply_source: null }, { reply_source: {} }, { reply_source: { ...guard, author_id: OWNER } },
    { reply_source: { ...guard, source_text_sha256: "0".repeat(64) } },
    { reply_source: { ...guard, source_message_id: snowflake() } },
    { reply_source: { ...guard, guild_id: "333444555666777889" } },
    { channel_id: "222333444555666778" }, { bot: "croissand" },
  ]) assert.ok((await guardedSend(m, patch)).status >= 400);
  await event("MESSAGE_UPDATE", { id: m.id, channel_id: CHANNEL });
  assert.equal((await guardedSend(m)).status, 403);
  const old = message({ id: snowflake(Date.now() - DAY - 1) });
  await event("MESSAGE_CREATE", old);
  assert.equal((await guardedSend(old)).status, 403);
  assert.equal(sends.length, count);
});

test("send guard: a verified source sends once as ichihime with mentions disabled", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  assert.equal((await guardedSend(m, { content: "@everyone <@333933401314951168> synthetic" })).status, 201);
  assert.equal(sends.length, count + 1);
  assert.equal(sends.at(-1).authorization, "Bot synthetic-i");
  assert.equal(sends.at(-1).url, `https://discord.com/api/v10/channels/${CHANNEL}/messages`);
  assert.deepEqual(sends.at(-1).body.allowed_mentions, { parse: [] });
});

test("send guard: revocation during a 429 wait prevents the next Discord POST", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  let invalidation;
  onSend = async () => {
    invalidation = new Promise((resolve, reject) => setTimeout(() => event("MESSAGE_DELETE", { id: m.id, channel_id: CHANNEL }).then(resolve, reject), 20));
    return Response.json({ retry_after: 0.05 }, { status: 429 });
  };
  try {
    assert.equal((await guardedSend(m)).status, 403);
    await invalidation;
    assert.equal(sends.length, count + 1);
  } finally { onSend = undefined; }
});

test("send guard: expiration during a 429 wait also prevents the next POST", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  onSend = async () => {
    await stub.fetch("https://internal/test/expire", { method: "POST", body: JSON.stringify({ id: m.id }) });
    return Response.json({ retry_after: 0.01 }, { status: 429 });
  };
  try {
    assert.equal((await guardedSend(m)).status, 403);
    assert.equal(sends.length, count + 1);
  } finally { onSend = undefined; }
});

test("send guard: an in-flight POST does not block revocation and later chunks are stopped", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const count = sends.length;
  onSend = async () => {
    await event("MESSAGE_UPDATE", { id: m.id, channel_id: CHANNEL });
    return Response.json({ id: "first-chunk-started" }, { status: 201 });
  };
  try {
    const result = await guardedSend(m, { content: "x".repeat(2500) });
    assert.equal(result.status, 403);
    assert.equal(result.body.chunks_sent, 1);
    assert.deepEqual(result.body.message_ids, ["first-chunk-started"]);
    assert.equal(sends.length, count + 1);
  } finally { onSend = undefined; }
});

test("send: manual callers without reply_source retain the original independent path", async () => {
  const count = sends.length;
  const result = await post("/send", { channel_id: "123456789012345678", content: "manual synthetic" });
  assert.equal(result.status, 201);
  assert.equal(sends.length, count + 1);
  assert.equal(sends.at(-1).authorization, "Bot synthetic-c");
  assert.deepEqual(sends.at(-1).body.allowed_mentions, { parse: [] });
  assert.equal((await post("/send", { channel_id: CHANNEL, content: "unauthorized" }, null)).status, 401);
  assert.equal(sends.length, count + 1);
});

test("source: missing reply metadata is unknown, never an unaddressed post", async () => {
  const count = sends.length;
  for (const patch of [
    { type: 19 }, { referenced_message: null }, { referenced_message: { author: { id: BOT } } },
    { message_snapshots: [] }, { type: 0, message_reference: { message_id: snowflake(), channel_id: CHANNEL } },
  ]) {
    const m = message(patch);
    await event("MESSAGE_CREATE", m);
    const result = await verify(m);
    assert.equal(result.body.verified, true);
    assert.equal(result.body.reply_context, "unknown");
    assert.equal((await guardedSend(m)).status, 403);
  }
  assert.equal(sends.length, count);
});

test("source: unsupported system and forwarded message types do not become reply sources", async () => {
  const count = sends.length;
  for (const type of [1, 6, 20, 21, 99, "0", null]) {
    const m = message({ type });
    await event("MESSAGE_CREATE", m);
    assert.deepEqual((await verify(m)).body, { verified: false });
    assert.equal((await guardedSend(m)).status, 403);
  }
  assert.equal(sends.length, count);
});

test("source migration: old records default to self_mentioned=0, cannot be revived by replay, and never send", async () => {
  const m = message();
  await event("MESSAGE_CREATE", m);
  const original = (await rows()).find((row) => row.source_message_id === m.id);
  assert.equal(original.self_mentioned, 1);
  const count = sends.length;
  const response = await stub.fetch("https://internal/test/legacy-schema", { method: "POST" });
  assert.equal(response.status, 200);
  const columns = await response.json();
  const migratedColumn = columns.filter((column) => column.name === "self_mentioned");
  assert.equal(migratedColumn.length, 1, "repeated migration must not add duplicate columns");
  assert.equal(migratedColumn[0].notnull, 1);
  assert.equal(migratedColumn[0].dflt_value, "0");
  const migrated = (await rows()).find((row) => row.source_message_id === m.id);
  assert.deepEqual(migrated, { ...original, self_mentioned: 0 }, "existing data must be preserved");
  assert.deepEqual((await verify(m)).body, { verified: false });
  assert.equal((await guardedSend(m)).status, 403);
  await event("MESSAGE_CREATE", m);
  assert.deepEqual((await verify(m)).body, { verified: false });
  assert.equal((await guardedSend(m)).status, 403);
  assert.equal(sends.length, count);
  const fresh = message();
  await event("MESSAGE_CREATE", fresh);
  const proof = (await verify(fresh)).body;
  assert.equal(proof.verified, true);
  assert.equal(proof.self_mentioned, true);
  assert.equal((await guardedSend(fresh)).status, 201);
  assert.equal(sends.length, count + 1);
});

// Tests for the Hermes ambient shadow feed (worker.js, Phase 1):
// - buildAmbientRequest copies only main-channel human messages that
//   mention neither hosted bot (topic "hermes-ambient", request_id
//   "ambient-<message id>", same header line as a regular forward).
// - handleGatewayPayload emits an "ambient" action next to (never
//   instead of) the existing "forward" action; the Durable Object
//   enqueues it from croissand's stream only.
// - Ambient copies sit in croissand's outbox but are delivered to
//   dots-events' /trigger in trigger mode (attemptForward's mode
//   override), deduplicated by (bot, request_id) like any forward.
// - Copies filed during JST quiet hours (23:00–08:00) are held in the
//   outbox until the next 08:00 JST (ambientDeliveryTime).
// Pure helpers are imported through the same source transform as
// gateway.test.mjs; the Durable Object paths run against a fake
// in-memory SQL store and a stubbed global fetch, as in
// forward-mode.test.mjs.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOOK_SECRET = "whsec_" + randomBytes(32).toString("base64");
const TRIGGER_KEY = "test-trigger-key";

const GUILD_ID = "413624636673359882";
const CHANNEL_ID = "477496219040743435";
const CROISSAND_ID = "1568508479293890673";
const ICHIHIME_ID = "1568548424519913482";
const OWNER_ID = "333933401314951168";

let pure;
let DS; // DEFAULT_GATEWAY_STATE, reached via __testHooks()
before(async () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const stubbed = src.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  );
  assert.notEqual(stubbed, src, "cloudflare:workers import not found to stub");
  const dir = mkdtempSync(join(tmpdir(), "discord-gateway-ambient-test-"));
  const file = join(dir, "worker-under-test.mjs");
  writeFileSync(file, stubbed);
  pure = await import(pathToFileURL(file).href);
  DS = pure.__testHooks().DEFAULT_GATEWAY_STATE;
});

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (respond instanceof Error) throw respond;
    return respond;
  };
  return { impl, calls };
}

const okJson = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

async function withGlobalFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------- buildAmbientRequest ----------

function ambientMessage(overrides = {}) {
  return {
    id: "222333444555666777",
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    content: "just chatting",
    author: { id: OWNER_ID, username: "g_kari", bot: false },
    mentions: [],
    ...overrides,
  };
}

test("ambient: a plain main-channel message is copied with the forward header shape", () => {
  const req = pure.buildAmbientRequest(ambientMessage());
  assert.ok(req);
  assert.equal(req.topic, "hermes-ambient");
  assert.equal(req.request_id, "ambient-222333444555666777");
  assert.equal(
    req.text,
    `[discord channel:${CHANNEL_ID} guild:${GUILD_ID} author:g_kari]\njust chatting`
  );
});

test("ambient: other members' plain messages are copied too (the feed is the channel, not the owner)", () => {
  const req = pure.buildAmbientRequest(
    ambientMessage({
      author: { id: "444555666777888999", username: "alice", bot: false },
      content: "  hello all  ",
    })
  );
  assert.ok(req);
  assert.equal(
    req.text,
    `[discord channel:${CHANNEL_ID} guild:${GUILD_ID} author:alice]\nhello all`
  );
});

test("ambient: a message mentioning croissand belongs to the forward route, not the feed", () => {
  const m = ambientMessage({
    content: `<@${CROISSAND_ID}> please check this`,
    mentions: [{ id: CROISSAND_ID, username: "croissand" }],
  });
  assert.equal(pure.buildAmbientRequest(m), null);
  // The existing route still owns it.
  assert.ok(pure.buildForwardRequest(m, CROISSAND_ID));
});

test("ambient: a message mentioning ichihime belongs to the forward route, not the feed", () => {
  const m = ambientMessage({
    content: `<@${ICHIHIME_ID}> please check this`,
    mentions: [{ id: ICHIHIME_ID, username: "ichihime" }],
  });
  assert.equal(pure.buildAmbientRequest(m), null);
  assert.ok(pure.buildForwardRequest(m, ICHIHIME_ID));
});

test("ambient: a bare croissand mention token in the text (no mention metadata) is still a mention", () => {
  const m = ambientMessage({ content: `<@${CROISSAND_ID}> hi`, mentions: [] });
  assert.equal(pure.buildAmbientRequest(m), null);
});

test("ambient: mentions of third parties do not exclude a message", () => {
  const req = pure.buildAmbientRequest(
    ambientMessage({
      content: "<@444555666777888999> look at this",
      mentions: [{ id: "444555666777888999", username: "alice" }],
    })
  );
  assert.ok(req);
  assert.ok(req.text.endsWith("\n<@444555666777888999> look at this"));
});

test("ambient: bot authors and webhooks are never copied", () => {
  assert.equal(
    pure.buildAmbientRequest(
      ambientMessage({
        author: { id: "555666777888999000", username: "other-bot", bot: true },
      })
    ),
    null
  );
  assert.equal(
    pure.buildAmbientRequest(
      ambientMessage({
        author: { id: CROISSAND_ID, username: "croissand", bot: true },
      })
    ),
    null
  );
  assert.equal(
    pure.buildAmbientRequest(ambientMessage({ webhook_id: "999888777" })),
    null
  );
});

test("ambient: only the one main channel of the one guild is in scope", () => {
  assert.equal(
    pure.buildAmbientRequest(ambientMessage({ channel_id: "111222333444555666" })),
    null
  );
  assert.equal(
    pure.buildAmbientRequest(ambientMessage({ guild_id: "111222333444555666" })),
    null
  );
  // A DM has no guild at all.
  assert.equal(
    pure.buildAmbientRequest(ambientMessage({ guild_id: undefined })),
    null
  );
  // Empty / whitespace-only content carries nothing to shadow.
  assert.equal(pure.buildAmbientRequest(ambientMessage({ content: "   " })), null);
});

// ---------- handleGatewayPayload: the ambient action ----------

test("ambient: a MESSAGE_CREATE dispatch yields an ambient action and no forward action", () => {
  const start = { ...DS, botUserId: CROISSAND_ID };
  const { actions } = pure.handleGatewayPayload(
    start,
    { op: 0, s: 7, t: "MESSAGE_CREATE", d: ambientMessage() },
    { now: 1762470000000 }
  );
  const ambient = actions.filter((a) => a.type === "ambient");
  assert.equal(ambient.length, 1);
  assert.equal(ambient[0].request.topic, "hermes-ambient");
  assert.equal(ambient[0].request.request_id, "ambient-222333444555666777");
  assert.equal(actions.filter((a) => a.type === "forward").length, 0);
});

test("ambient: a mentioned dispatch yields the forward action and no ambient action", () => {
  const start = { ...DS, botUserId: CROISSAND_ID };
  const m = ambientMessage({
    content: `<@${CROISSAND_ID}> please check this`,
    mentions: [{ id: CROISSAND_ID, username: "croissand" }],
  });
  const { actions } = pure.handleGatewayPayload(
    start,
    { op: 0, s: 8, t: "MESSAGE_CREATE", d: m },
    { now: 1762470000000 }
  );
  assert.equal(actions.filter((a) => a.type === "forward").length, 1);
  assert.equal(actions.filter((a) => a.type === "ambient").length, 0);
});

// ---------- ambientDeliveryTime (JST quiet hours 23:00–08:00) ----------

test("ambient: delivery time is immediate outside quiet hours", () => {
  // 2026-11-11 03:00 UTC = 12:00 JST.
  const noon = Date.UTC(2026, 10, 11, 3, 0, 0);
  assert.equal(pure.ambientDeliveryTime(noon), noon);
  // Exactly 08:00 JST (2026-11-10 23:00 UTC) is already due.
  const eight = Date.UTC(2026, 10, 10, 23, 0, 0);
  assert.equal(pure.ambientDeliveryTime(eight), eight);
  // 22:59 JST (13:59 UTC) is still due immediately.
  const late = Date.UTC(2026, 10, 11, 13, 59, 0);
  assert.equal(pure.ambientDeliveryTime(late), late);
});

test("ambient: copies filed in quiet hours wait for the next 08:00 JST", () => {
  // 23:30 JST (14:30 UTC) -> next morning 08:00 JST (23:00 UTC).
  assert.equal(
    pure.ambientDeliveryTime(Date.UTC(2026, 10, 11, 14, 30, 0)),
    Date.UTC(2026, 10, 11, 23, 0, 0)
  );
  // Exactly 23:00 JST (14:00 UTC) is already quiet.
  assert.equal(
    pure.ambientDeliveryTime(Date.UTC(2026, 10, 11, 14, 0, 0)),
    Date.UTC(2026, 10, 11, 23, 0, 0)
  );
  // 02:00 JST (17:00 UTC the previous day) -> same JST day 08:00 (23:00 UTC).
  assert.equal(
    pure.ambientDeliveryTime(Date.UTC(2026, 10, 11, 17, 0, 0)),
    Date.UTC(2026, 10, 11, 23, 0, 0)
  );
  // Month boundary: 2026-11-30 15:00 UTC = 2026-12-01 00:00 JST
  // -> 2026-12-01 08:00 JST = 2026-11-30 23:00 UTC.
  assert.equal(
    pure.ambientDeliveryTime(Date.UTC(2026, 10, 30, 15, 0, 0)),
    Date.UTC(2026, 10, 30, 23, 0, 0)
  );
});

// ---------- attemptForward: the mode override ----------

const AMBIENT_BODY = JSON.stringify({
  text: `[discord channel:${CHANNEL_ID} guild:${GUILD_ID} author:g_kari]\njust chatting`,
  topic: "hermes-ambient",
  request_id: "ambient-222333444555666777",
});

test("ambient: attemptForward with mode 'trigger' delivers a croissand row to /trigger", async () => {
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env: { CLAUDE_HOOK_SECRET: HOOK_SECRET, EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    bot: "croissand",
    mode: "trigger",
    fetchImpl: impl,
    requestId: "ambient-222333444555666777",
    body: AMBIENT_BODY,
  });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/trigger");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TRIGGER_KEY}`);
  assert.equal(calls[0].init.headers["webhook-signature"], undefined);
  assert.equal(calls[0].init.body, AMBIENT_BODY);
});

test("ambient: attemptForward with mode 'claude-hook' overrides a trigger bot symmetrically", async () => {
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env: { CLAUDE_HOOK_SECRET: HOOK_SECRET, EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    bot: "ichihime",
    mode: "claude-hook",
    fetchImpl: impl,
    requestId: "ambient-222333444555666777",
    body: AMBIENT_BODY,
  });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/claude-hook");
  assert.ok(calls[0].init.headers["webhook-signature"]);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

// ---------- Durable Object paths with a fake SQL store ----------

// Minimal in-memory stand-in for the DO's SQLite tables, keyed on the
// exact statements the ambient enqueue / outbox paths issue.
function fakeSql() {
  const outbox = new Map();
  const forwardLog = new Map();
  const exec = (sql, ...params) => {
    if (sql.startsWith("INSERT OR IGNORE INTO outbox")) {
      const [bot, requestId, body, nextAttemptAt, createdAt] = params;
      const key = `${bot}:${requestId}`;
      if (!outbox.has(key)) {
        outbox.set(key, {
          bot,
          request_id: requestId,
          body,
          attempts: 0,
          next_attempt_at: nextAttemptAt,
          created_at: createdAt,
        });
      }
      return { toArray: () => [] };
    }
    if (sql.startsWith("SELECT request_id FROM forward_log")) {
      const key = `${params[0]}:${params[1]}`;
      return { toArray: () => (forwardLog.has(key) ? [{ request_id: params[1] }] : []) };
    }
    if (sql.startsWith("SELECT bot, request_id, body, attempts FROM outbox")) {
      const [bot, now] = params;
      const rows = [...outbox.values()]
        .filter((r) => r.bot === bot && r.next_attempt_at <= now)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, 10);
      return { toArray: () => rows };
    }
    if (sql.startsWith("SELECT MIN(next_attempt_at)")) {
      const bot = params[0];
      const vals = [...outbox.values()]
        .filter((r) => bot === undefined || r.bot === bot)
        .map((r) => r.next_attempt_at);
      return { toArray: () => [{ m: vals.length ? Math.min(...vals) : null }] };
    }
    if (sql.startsWith("DELETE FROM outbox")) {
      outbox.delete(`${params[0]}:${params[1]}`);
      return { toArray: () => [] };
    }
    if (sql.startsWith("INSERT OR REPLACE INTO forward_log")) {
      forwardLog.set(`${params[0]}:${params[1]}`, params[2]);
      return { toArray: () => [] };
    }
    if (sql.startsWith("UPDATE outbox")) {
      const row = outbox.get(`${params[2]}:${params[3]}`);
      if (row) {
        row.attempts = params[0];
        row.next_attempt_at = params[1];
      }
      return { toArray: () => [] };
    }
    if (sql.startsWith("DELETE FROM forward_log")) {
      for (const [key, at] of forwardLog) {
        if (at < params[0]) forwardLog.delete(key);
      }
      return { toArray: () => [] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return { exec, outbox, forwardLog };
}

function gatewayWithStore(env, store) {
  const gateway = Object.create(pure.Gateway.prototype);
  gateway.env = env;
  gateway._lock = Promise.resolve();
  gateway.ctx = { storage: { sql: { exec: store.exec } } };
  let state = { ...DS };
  gateway.loadState = () => ({ ...state });
  gateway.saveState = (s) => (state = { ...s });
  gateway.scheduleAlarmLocked = async () => {};
  gateway.getState = () => state;
  return gateway;
}

const CROISSAND_ENV = {
  DISCORD_BOT_TOKEN: "synthetic-token",
  CLAUDE_HOOK_SECRET: HOOK_SECRET,
  EVENTS_TRIGGER_KEY: TRIGGER_KEY,
};

// A daytime JST instant in the past, so a copy filed then is due at
// once and always due by the time the test runs.
const DAYTIME_JST = Date.UTC(2020, 0, 1, 3, 0, 0); // 2020-01-01 12:00 JST
// A quiet-hours JST instant in the far future, so the hold target is
// deterministic whenever the test runs.
const QUIET_JST = Date.UTC(2099, 0, 1, 14, 30, 0); // 2099-01-01 23:30 JST
const QUIET_RELEASE = Date.UTC(2099, 0, 1, 23, 0, 0); // 2099-01-02 08:00 JST

const ambientRequest = () => pure.buildAmbientRequest(ambientMessage());

test("ambient: an enqueued copy is delivered to /trigger in trigger mode and logged", async () => {
  const store = fakeSql();
  const gateway = gatewayWithStore(CROISSAND_ENV, store);
  await gateway.enqueueAmbientForward(ambientRequest(), DAYTIME_JST);
  const key = "croissand:ambient-222333444555666777";
  assert.ok(store.outbox.has(key));
  assert.equal(store.outbox.get(key).next_attempt_at, DAYTIME_JST);

  const { impl, calls } = fakeFetch(okJson());
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/trigger");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TRIGGER_KEY}`);
  assert.equal(JSON.parse(calls[0].init.body).topic, "hermes-ambient");
  assert.equal(store.outbox.size, 0);
  assert.ok(store.forwardLog.has(key));
  assert.equal(gateway.getState().forwardedCount, 1);
});

test("ambient: the same message enqueued twice (resume replay) is filed once", async () => {
  const store = fakeSql();
  const gateway = gatewayWithStore(CROISSAND_ENV, store);
  await gateway.enqueueAmbientForward(ambientRequest(), DAYTIME_JST);
  await gateway.enqueueAmbientForward(ambientRequest(), DAYTIME_JST);
  assert.equal(store.outbox.size, 1);
  const { impl, calls } = fakeFetch(okJson());
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 1);
  // After delivery, forward_log blocks a late replay entirely.
  await gateway.enqueueAmbientForward(ambientRequest(), DAYTIME_JST);
  assert.equal(store.outbox.size, 0);
});

test("ambient: a copy filed in quiet hours is held in the outbox until 08:00 JST", async () => {
  const store = fakeSql();
  const gateway = gatewayWithStore(CROISSAND_ENV, store);
  await gateway.enqueueAmbientForward(ambientRequest(), QUIET_JST);
  const key = "croissand:ambient-222333444555666777";
  const row = store.outbox.get(key);
  assert.ok(row);
  assert.equal(row.next_attempt_at, QUIET_RELEASE);
  // The flush leaves a held row untouched: no fetch, row preserved.
  const { impl, calls } = fakeFetch(okJson());
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 0);
  assert.equal(store.outbox.size, 1);
});

test("ambient: only croissand's stream enqueues the shadow copy", async () => {
  const store = fakeSql();
  const gateway = gatewayWithStore(CROISSAND_ENV, store);
  const actions = [{ type: "ambient", request: ambientRequest() }];
  await gateway.executeGatewayActions("ichihime", null, { ...DS }, actions);
  assert.equal(store.outbox.size, 0);
  await gateway.executeGatewayActions("croissand", null, { ...DS }, actions);
  assert.equal(store.outbox.size, 1);
  assert.ok(store.outbox.has("croissand:ambient-222333444555666777"));
});

test("ambient: a failed delivery keeps the row queued for a retry", async () => {
  const store = fakeSql();
  const gateway = gatewayWithStore(CROISSAND_ENV, store);
  await gateway.enqueueAmbientForward(ambientRequest(), DAYTIME_JST);
  const { impl, calls } = fakeFetch(new Response("unavailable", { status: 503 }));
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 1);
  const row = store.outbox.get("croissand:ambient-222333444555666777");
  assert.ok(row);
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > Date.now());
  assert.equal(store.forwardLog.size, 0);
  assert.equal(gateway.getState().forwardedCount, 0);
});

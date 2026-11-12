// Tests for the two-bot shared-Durable-Object layout (worker.js v0.5):
// - one Gateway object hosts croissand + ichihime, each with its own
//   token, forward mode, connection, and per-bot persisted state
// - the legacy single-bot state row migrates to croissand in place;
//   outbox / forward_log gain a bot dimension the same way
// - an unconfigured bot (ichihime before its token is registered)
//   stays idle and silent while croissand runs
// - /send and /avatar select the bot explicitly; unknown bot → 400
// Pure/DO logic is imported through the same source transform as
// gateway.test.mjs; HTTP behavior runs on Miniflare with a mocked
// outbound service. The real Discord service is never contacted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";

const HOOK_SECRET = "whsec_" + randomBytes(32).toString("base64");
const TRIGGER_KEY = "test-trigger-key";
const CROISSAND_TOKEN = "croissand-token";
const ICHIHIME_TOKEN = "ichihime-token";
const ADMIN_KEY = "test-admin-key";
const ORIGIN = "https://discord-gateway.test";
const BODY = JSON.stringify({
  text: "[discord channel:1 guild:- author:alice]\nhello",
  topic: "discord",
  request_id: "discord-42",
});
const PNG_1PX_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

let pure;
let DS; // DEFAULT_GATEWAY_STATE, reached via __testHooks()
before(async () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const stubbed = src.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  );
  assert.notEqual(stubbed, src, "cloudflare:workers import not found to stub");
  const dir = mkdtempSync(join(tmpdir(), "discord-gateway-multibot-test-"));
  const file = join(dir, "worker-under-test.mjs");
  writeFileSync(file, stubbed);
  pure = await import(pathToFileURL(file).href);
  DS = pure.__testHooks().DEFAULT_GATEWAY_STATE;
});

// ---------- fakes ----------

// In-memory kv table backing the REAL loadState/saveState (and the
// legacy-state migration inside loadState).
function fakeKv() {
  const map = new Map();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT key, value FROM kv")) {
      const v = map.get(params[0]);
      return {
        toArray: () => (v === undefined ? [] : [{ key: params[0], value: v }]),
      };
    }
    if (sql.startsWith("INSERT INTO kv")) {
      map.set(params[0], params[1]);
      return { toArray: () => [] };
    }
    if (sql.startsWith("DELETE FROM kv")) {
      map.delete(params[0]);
      return { toArray: () => [] };
    }
    if (sql.startsWith("SELECT MIN(next_attempt_at)")) {
      return { toArray: () => [{ m: null }] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return { exec, map };
}

// A Gateway instance wired to fake storage. `extraExec` handles any
// non-kv statements (returning undefined lets the kv fake throw).
function makeGateway(env, exec) {
  const gateway = Object.create(pure.Gateway.prototype);
  const alarmSets = [];
  const flushes = [];
  gateway.env = env;
  gateway._lock = Promise.resolve();
  gateway._sockets = {};
  gateway._flushPromises = {};
  gateway._connectPromises = {};
  gateway.ctx = {
    storage: {
      sql: { exec },
      getAlarm: async () => null,
      setAlarm: async (t) => {
        alarmSets.push(t);
      },
      deleteAlarm: async () => {},
    },
    waitUntil: (p) => {
      flushes.push(p);
    },
  };
  return { gateway, alarmSets, flushes };
}

async function withGlobalFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function completesPromptly(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- bot registry ----------

test("registry: bot configs match the hosted production bots", () => {
  const hooks = pure.__testHooks();
  assert.equal(hooks.PRIMARY_BOT, "croissand");
  assert.deepEqual(hooks.BOT_KEYS, ["croissand", "ichihime", "tako"]);
  const c = hooks.BOT_CONFIGS.croissand;
  assert.equal(c.tokenEnv, "DISCORD_BOT_TOKEN");
  assert.equal(c.forwardMode, "claude-hook");
  assert.equal(c.forwardSecretEnv, "CLAUDE_HOOK_SECRET");
  assert.equal(c.userId, "1568508479293890673");
  const i = hooks.BOT_CONFIGS.ichihime;
  assert.equal(i.tokenEnv, "DISCORD_BOT_TOKEN_ICHICHIME");
  assert.equal(i.forwardMode, "trigger");
  assert.equal(i.forwardSecretEnv, "EVENTS_TRIGGER_KEY");
  assert.equal(i.userId, "1568548424519913482");
  const t = hooks.BOT_CONFIGS.tako;
  assert.equal(t.tokenEnv, "DISCORD_BOT_TOKEN_TAKO");
  assert.equal(t.forwardMode, "webhook");
  assert.equal(t.forwardSecretEnv, "TAKO_WEBHOOK_KEY");
  assert.equal(t.webhookUrlEnv, "TAKO_WEBHOOK_URL");
  assert.equal(t.webhookAuthHeaderEnv, "TAKO_WEBHOOK_AUTH_HEADER");
  assert.deepEqual(t.names, ["たこ", "たこ · 秘書", "tako"]);
  assert.equal(t.userId, null);
  assert.equal(
    pure.botConfigured(
      { DISCORD_BOT_TOKEN: "t", CLAUDE_HOOK_SECRET: "s" },
      "croissand"
    ),
    true
  );
  assert.equal(pure.botConfigured({ DISCORD_BOT_TOKEN: "t" }, "croissand"), false);
  assert.equal(pure.botConfigured({}, "nope"), false);
});

// ---------- attemptForward with an explicit bot ----------

test("attemptForward: the bot picks the mode — croissand signs, ichihime bears", async () => {
  // FORWARD_MODE=trigger is set as a trap: the bot's static config
  // must win over the legacy env fallback in both directions.
  const env = {
    CLAUDE_HOOK_SECRET: HOOK_SECRET,
    EVENTS_TRIGGER_KEY: TRIGGER_KEY,
    FORWARD_MODE: "trigger",
  };
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const r1 = await pure.attemptForward({
    env,
    bot: "croissand",
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(r1.delivered, true);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/claude-hook");
  assert.ok(calls[0].init.headers["webhook-signature"]);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(
    await pure.verifyBody(
      HOOK_SECRET,
      "discord-42",
      calls[0].init.headers["webhook-timestamp"],
      BODY,
      calls[0].init.headers["webhook-signature"]
    ),
    true
  );
  const r2 = await pure.attemptForward({
    env,
    bot: "ichihime",
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(r2.delivered, true);
  assert.equal(calls[1].url, "https://dots-events.0g0.xyz/trigger");
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TRIGGER_KEY}`);
  assert.equal(calls[1].init.headers["webhook-signature"], undefined);
  // The forwarded body is byte-identical for both bots.
  assert.equal(calls[0].init.body, BODY);
  assert.equal(calls[1].init.body, BODY);
});

// ---------- legacy state migration ----------

test("migration: the legacy single-bot state row becomes croissand's state", () => {
  const kv = fakeKv();
  kv.map.set(
    "gateway-state",
    JSON.stringify({
      sessionId: "legacy-sess",
      seq: 7,
      botUserId: "1568508479293890673",
      resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
      ready: true,
      connected: true,
    })
  );
  const { gateway } = makeGateway({}, kv.exec);
  const migrated = gateway.loadState("croissand");
  assert.equal(migrated.sessionId, "legacy-sess");
  assert.equal(migrated.seq, 7);
  assert.equal(migrated.botUserId, "1568508479293890673");
  assert.equal(
    migrated.resumeGatewayUrl,
    "wss://gateway-us-east1-b.discord.gg"
  );
  // Copied to the per-bot key; the legacy key is gone, so the
  // migration cannot replay over newer state.
  assert.ok(kv.map.has("gateway-state:croissand"));
  assert.equal(kv.map.has("gateway-state"), false);
  // ichihime starts from defaults — nothing leaks across bots.
  const ichi = gateway.loadState("ichihime");
  assert.equal(ichi.sessionId, null);
  assert.equal(ichi.seq, null);
  assert.equal(ichi.botUserId, null);
  // A second load reads the per-bot row, not a re-migration.
  assert.equal(gateway.loadState("croissand").sessionId, "legacy-sess");
  // Default load/save still address the primary bot.
  assert.equal(gateway.loadState().sessionId, "legacy-sess");
});

// ---------- per-bot state + socket isolation ----------

test("isolation: one bot's socket close never touches the other's session", async () => {
  const kv = fakeKv();
  const { gateway } = makeGateway(
    {
      DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
      CLAUDE_HOOK_SECRET: HOOK_SECRET,
      DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN,
      EVENTS_TRIGGER_KEY: TRIGGER_KEY,
    },
    kv.exec
  );
  gateway.saveState(
    { ...DS, sessionId: "sess-c", seq: 3, ready: true, connected: true },
    "croissand"
  );
  gateway.saveState(
    { ...DS, sessionId: "sess-i", seq: 9, ready: true, connected: true },
    "ichihime"
  );
  const wsA = { readyState: 1, close() {} };
  const wsB = { readyState: 1, close() {} };
  gateway._sockets = {
    croissand: { ws: wsA, mode: "inline" },
    ichihime: { ws: wsB, mode: "inline" },
  };
  await gateway.handleSocketClose("ichihime", wsB, 4000, "", true);
  const ichi = gateway.loadState("ichihime");
  assert.equal(ichi.sessionId, "sess-i"); // transient close keeps the session
  assert.equal(ichi.connected, false);
  assert.equal(typeof ichi.nextReconnectAt, "number");
  const croi = gateway.loadState("croissand");
  assert.equal(croi.sessionId, "sess-c");
  assert.equal(croi.seq, 3);
  assert.equal(croi.ready, true);
  assert.equal(croi.nextReconnectAt, null);
  assert.equal(gateway._sockets.ichihime, null);
  assert.equal(gateway._sockets.croissand.ws, wsA);
});

test("isolation: Identify on ichihime's connection carries ichihime's token", async () => {
  const kv = fakeKv();
  const env = {
    DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
    CLAUDE_HOOK_SECRET: HOOK_SECRET,
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN,
    EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  };
  const { gateway } = makeGateway(env, kv.exec);
  const sent = [];
  const wsB = {
    readyState: 1,
    close() {},
    send: (data) => sent.push(JSON.parse(data)),
  };
  gateway._sockets = { ichihime: { ws: wsB, mode: "inline" } };
  await gateway.handleSocketMessage(
    "ichihime",
    wsB,
    JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } })
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 2);
  assert.equal(sent[0].d.token, ICHIHIME_TOKEN);
  assert.equal(gateway.loadState("ichihime").helloReceived, true);
  // croissand's state was not touched by the other bot's handshake.
  assert.equal(gateway.loadState("croissand").helloReceived, false);
  assert.equal(gateway.loadState("croissand").botUserId, null);
});

test("isolation: a pending connect leaves the other bot's heartbeat, ACK and status live", async () => {
  const kv = fakeKv();
  const { gateway, flushes } = makeGateway({
    DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
    CLAUDE_HOOK_SECRET: HOOK_SECRET,
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN,
    EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  }, kv.exec);
  gateway.flushOutbox = async () => {};
  const sent = [];
  const ws = { readyState: 1, close() {}, send: (data) => sent.push(JSON.parse(data)) };
  gateway._sockets.ichihime = { ws, mode: "inline" };
  gateway.saveState({ ...DS, connected: true, ready: true, helloReceived: true,
    lastDispatchAt: Date.now(), nextHeartbeatAt: Date.now() - 1, seq: 17 }, "ichihime");
  const entered = deferred();
  const release = deferred();
  const impl = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("synthetic connection failure");
  };
  await withGlobalFetch(impl, async () => {
    const connect = gateway.fetch(new Request("https://local/internal/connect", {
      method: "POST", body: JSON.stringify({ bot: "croissand" }),
    }));
    await entered.promise;
    try {
      await completesPromptly(gateway.alarm(), "heartbeat blocked by another bot's connect");
      assert.ok(sent.some((f) => f.op === 1 && f.d === 17));
      await completesPromptly(gateway.handleSocketMessage("ichihime", ws, JSON.stringify({ op: 11 })),
        "ACK blocked by another bot's connect");
      assert.equal(gateway.loadState("ichihime").awaitingHeartbeatAck, false);
      const res = await completesPromptly(gateway.fetch(new Request("https://local/internal/status")),
        "status blocked by another bot's connect");
      assert.equal((await res.json()).bots.ichihime.ready, true);
    } finally {
      release.resolve();
      await connect;
      await Promise.all(flushes);
    }
  });
});

test("isolation: enqueueForward files and dedups per bot", async () => {
  const logged = new Set(["croissand:discord-x"]);
  const inserts = [];
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT key, value FROM kv")) {
      return { toArray: () => [] };
    }
    if (sql.startsWith("SELECT request_id FROM forward_log")) {
      return {
        toArray: () =>
          logged.has(`${params[0]}:${params[1]}`)
            ? [{ request_id: params[1] }]
            : [],
      };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO outbox")) {
      inserts.push({ bot: params[0], request_id: params[1] });
      return { toArray: () => [] };
    }
    if (sql.startsWith("SELECT MIN(next_attempt_at)")) {
      return { toArray: () => [{ m: inserts.some((r) => r.bot === params[0]) ? Date.now() : null }] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  const { gateway } = makeGateway({}, exec);
  const states = { croissand: { ...DS }, ichihime: { ...DS } };
  gateway.loadState = (k = "croissand") => ({ ...states[k] });
  gateway.saveState = (s, k = "croissand") => (states[k] = { ...s });
  const req = { text: "t", topic: "discord", request_id: "discord-x" };
  // Already forwarded by croissand → no new row for croissand...
  await gateway.enqueueForward(req, "croissand");
  assert.equal(inserts.length, 0);
  // ...but ichihime has not filed its own copy yet → row inserted,
  // and only ichihime's outbox timer is armed.
  await gateway.enqueueForward(req, "ichihime");
  assert.deepEqual(inserts, [{ bot: "ichihime", request_id: "discord-x" }]);
  assert.equal(typeof states.ichihime.nextOutboxAt, "number");
  assert.equal(states.croissand.nextOutboxAt, null);
});

// ---------- deliverOutbox dispatches per bot ----------

function fakeOutbox(rows) {
  const outbox = new Map(
    rows.map((r) => [`${r.bot}:${r.request_id}`, { ...r }])
  );
  const forwardLog = new Map();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT bot, request_id, body, attempts FROM outbox")) {
      const [bot, now] = params;
      const due = [...outbox.values()]
        .filter((r) => r.bot === bot && r.next_attempt_at <= now)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, 10);
      return { toArray: () => due };
    }
    if (sql.startsWith("SELECT MIN(next_attempt_at)")) {
      const vals = [...outbox.values()]
        .filter((r) => params[0] === undefined || r.bot === params[0])
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
      for (const [k, at] of forwardLog) {
        if (at < params[0]) forwardLog.delete(k);
      }
      return { toArray: () => [] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return { exec, outbox, forwardLog };
}

test("outbox: each bot's rows are delivered in that bot's own mode", async () => {
  const row = (bot, request_id) => ({
    bot,
    request_id,
    body: BODY.replace("discord-42", request_id),
    attempts: 0,
    next_attempt_at: Date.now() - 1,
    created_at: Date.now() - 2,
  });
  const store = fakeOutbox([
    row("croissand", "discord-c1"),
    row("ichihime", "discord-i1"),
    // The same Discord message filed by BOTH bots (e.g. it mentioned
    // both): each bot's copy must be delivered to its own target.
    row("croissand", "discord-same"),
    row("ichihime", "discord-same"),
  ]);
  const { gateway } = makeGateway(
    { DISCORD_BOT_TOKEN: CROISSAND_TOKEN, CLAUDE_HOOK_SECRET: HOOK_SECRET,
      DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN, EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    store.exec
  );
  const states = { croissand: { ...DS }, ichihime: { ...DS } };
  gateway.loadState = (k = "croissand") => ({ ...states[k] });
  gateway.saveState = (s, k = "croissand") => (states[k] = { ...s });
  gateway.scheduleAlarmLocked = async () => {};
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 4);
  const hookCalls = calls.filter((c) => c.url.endsWith("/claude-hook"));
  const triggerCalls = calls.filter((c) => c.url.endsWith("/trigger"));
  assert.equal(hookCalls.length, 2);
  assert.equal(triggerCalls.length, 2);
  for (const c of hookCalls) {
    assert.ok(c.init.headers["webhook-signature"]);
    assert.equal(c.init.headers.Authorization, undefined);
  }
  for (const c of triggerCalls) {
    assert.equal(c.init.headers.Authorization, `Bearer ${TRIGGER_KEY}`);
    assert.equal(c.init.headers["webhook-signature"], undefined);
  }
  assert.equal(store.outbox.size, 0);
  assert.equal(states.croissand.forwardedCount, 2);
  assert.equal(states.ichihime.forwardedCount, 2);
  assert.ok(store.forwardLog.has("croissand:discord-same"));
  assert.ok(store.forwardLog.has("ichihime:discord-same"));
});

test("outbox: more than a batch of suspended rows cannot starve a configured bot", async () => {
  const row = (bot, n) => ({ bot, request_id: `discord-${bot}-${n}`, body: BODY,
    attempts: 2, next_attempt_at: 1, created_at: n });
  const store = fakeOutbox([
    ...Array.from({ length: 12 }, (_, n) => row("croissand", n)),
    row("ichihime", 100),
  ]);
  const { gateway } = makeGateway({
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN, EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  }, store.exec);
  const states = { croissand: { ...DS }, ichihime: { ...DS } };
  gateway.loadState = (k) => ({ ...states[k] });
  gateway.saveState = (s, k) => (states[k] = { ...s });
  gateway.scheduleAlarmLocked = async () => {};
  const calls = [];
  await withGlobalFetch(async (url) => {
    calls.push(url);
    return new Response("ok");
  }, () => gateway.flushOutbox());
  assert.deepEqual(calls, ["https://dots-events.0g0.xyz/trigger"]);
  assert.equal(store.outbox.size, 12);
  assert.ok([...store.outbox.values()].every((r) => r.bot === "croissand" && r.attempts === 2));
  assert.equal(states.croissand.lastForwardError, null);
});

test("outbox: a missing bot token also suspends delivery without consuming attempts", async () => {
  const store = fakeOutbox([{ bot: "ichihime", request_id: "discord-pending", body: BODY,
    attempts: 2, next_attempt_at: 1, created_at: 1 }]);
  const { gateway } = makeGateway({ EVENTS_TRIGGER_KEY: TRIGGER_KEY }, store.exec);
  await withGlobalFetch(() => assert.fail("unconfigured bot made a network request"),
    () => gateway.flushOutbox());
  assert.equal(store.outbox.get("ichihime:discord-pending").attempts, 2);
});

test("outbox: a replay of a queued retry preserves its backoff deadline", async () => {
  const retryAt = Date.now() + 3600000;
  const store = fakeOutbox([{ bot: "ichihime", request_id: "discord-retry", body: BODY,
    attempts: 1, next_attempt_at: retryAt, created_at: 1 }]);
  const kv = fakeKv();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT request_id FROM forward_log")) return { toArray: () => [] };
    if (sql.startsWith("INSERT OR IGNORE INTO outbox")) return { toArray: () => [] };
    if (sql.includes("FROM kv") || sql.startsWith("INSERT INTO kv")) return kv.exec(sql, ...params);
    return store.exec(sql, ...params);
  };
  const { gateway, alarmSets } = makeGateway({
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN, EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  }, exec);
  await gateway.enqueueForward({ request_id: "discord-retry" }, "ichihime");
  assert.equal(gateway.loadState("ichihime").nextOutboxAt, retryAt);
  await gateway.flushOutbox();
  await gateway.scheduleAlarmLocked();
  assert.ok(alarmSets.at(-1) - Date.now() > 59000, "replayed retry armed an immediate alarm");
  // Heal any stale cached deadline left by an older deployment too.
  gateway.saveState({ ...gateway.loadState("ichihime"), nextOutboxAt: 1 }, "ichihime");
  await gateway.flushOutbox();
  assert.equal(gateway.loadState("ichihime").nextOutboxAt, retryAt);
});

test("outbox: a slow bot's target does not block or duplicate the other bot's delivery", async () => {
  const store = fakeOutbox(["croissand", "ichihime"].map((bot) => ({
    bot, request_id: `discord-${bot}`, body: BODY, attempts: 0, next_attempt_at: 1, created_at: 1,
  })));
  const { gateway } = makeGateway({
    DISCORD_BOT_TOKEN: CROISSAND_TOKEN, CLAUDE_HOOK_SECRET: HOOK_SECRET,
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN, EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  }, store.exec);
  const states = { croissand: { ...DS }, ichihime: { ...DS } };
  gateway.loadState = (k) => ({ ...states[k] });
  gateway.saveState = (s, k) => (states[k] = { ...s });
  gateway.scheduleAlarmLocked = async () => {};
  const release = deferred();
  const entered = deferred();
  const fastDone = deferred();
  const calls = [];
  await withGlobalFetch(async (url) => {
    calls.push(url);
    if (url.endsWith("/claude-hook")) { entered.resolve(); await release.promise; }
    else fastDone.resolve();
    return new Response("ok");
  }, async () => {
    const pending = gateway.flushOutbox();
    await entered.promise;
    try {
      await completesPromptly(fastDone.promise, "other bot's outbox blocked by a slow target");
      await gateway.runLocked(() => {});
      const again = gateway.flushOutbox();
      release.resolve();
      await Promise.all([pending, again]);
    } finally { release.resolve(); await pending; }
  });
  assert.equal(calls.length, 2);
  assert.equal(store.outbox.size, 0);
  assert.equal(states.croissand.forwardedCount, 1);
  assert.equal(states.ichihime.forwardedCount, 1);
});

// ---------- unconfigured bot stays idle ----------

test("unconfigured ichihime: quiet under connect and alarm; croissand unaffected", async () => {
  const kv = fakeKv();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT bot, request_id, body, attempts FROM outbox")) {
      return { toArray: () => [] };
    }
    return kv.exec(sql, ...params);
  };
  const { gateway, flushes } = makeGateway(
    { DISCORD_BOT_TOKEN: CROISSAND_TOKEN, CLAUDE_HOOK_SECRET: HOOK_SECRET },
    exec
  );
  // A manual nudge reports ichihime as unconfigured, without creating
  // a socket or recording an error.
  const snap = await gateway.connectLocked("ichihime", { manual: true });
  assert.deepEqual(snap, { connected: false, ready: false, configured: false });
  assert.equal(
    gateway.loadState("ichihime").lastError,
    null
  );
  assert.equal(gateway._sockets.ichihime ?? null, null);
  // Under alarm, ichihime is skipped entirely (no connect attempt:
  // its reconnect timer is never armed), while croissand — whose
  // network is stubbed down here — attempts and backs off.
  const down = async () => {
    throw new Error("network down");
  };
  await withGlobalFetch(down, () => gateway.alarm());
  await Promise.all(flushes);
  const croi = gateway.loadState("croissand");
  assert.equal(typeof croi.nextReconnectAt, "number");
  const ichi = gateway.loadState("ichihime");
  assert.equal(ichi.nextReconnectAt, null);
  assert.equal(ichi.sessionId, null);
  assert.equal(ichi.ready, false);
});

// ---------- alarm scheduling: earliest due across bots ----------

test("alarm: the wake-up is the earliest deadline across both bots", async () => {
  const kv = fakeKv();
  const env = {
    DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
    CLAUDE_HOOK_SECRET: HOOK_SECRET,
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN,
    EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  };
  const { gateway, alarmSets } = makeGateway(env, kv.exec);
  const now = Date.now();
  gateway.saveState({ ...DS, nextHeartbeatAt: now + 30000 }, "croissand");
  gateway.saveState(
    { ...DS, nextHeartbeatAt: now + 5000, nextOutboxAt: now + 2000 },
    "ichihime"
  );
  await gateway.scheduleAlarmLocked();
  assert.equal(alarmSets.length, 1);
  const delta = alarmSets[0] - Date.now();
  assert.ok(delta >= 1500 && delta <= 2500, `expected ~2000ms, got ${delta}`);
  // With ichihime's early deadlines cleared, croissand's heartbeat
  // becomes the minimum (ahead of the 60s watchdog).
  gateway.saveState(
    { ...DS, nextHeartbeatAt: now + 45000, nextOutboxAt: null },
    "ichihime"
  );
  await gateway.scheduleAlarmLocked();
  assert.equal(alarmSets.length, 2);
  const delta2 = alarmSets[1] - Date.now();
  assert.ok(
    delta2 >= 29000 && delta2 <= 31000,
    `expected ~30000ms, got ${delta2}`
  );
});

test("alarm: stale deadlines of an unconfigured bot cannot cause a 250ms loop", async () => {
  const kv = fakeKv();
  const { gateway, alarmSets } = makeGateway({
    DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN, EVENTS_TRIGGER_KEY: TRIGGER_KEY,
  }, kv.exec);
  const now = Date.now();
  gateway.saveState({ ...DS, nextHeartbeatAt: now - 1, nextWatchdogAt: now - 1,
    nextReconnectAt: now - 1, nextOutboxAt: now - 1, ready: true, lastDispatchAt: 1 }, "croissand");
  gateway.saveState({ ...DS, nextHeartbeatAt: now + 30000 }, "ichihime");
  await gateway.alarmBotLocked("croissand", now);
  await gateway.scheduleAlarmLocked();
  assert.ok(alarmSets[0] - Date.now() > 29000);
});

// ---------- HTTP surface on Miniflare ----------

function makeOutboundRecorder() {
  const sends = [];
  let avatarAuth = null;
  const service = async (req) => {
    if (
      req.url === "https://discord.com/api/v10/users/@me" &&
      req.method === "PATCH"
    ) {
      avatarAuth = req.headers.get("Authorization");
      return Response.json(
        { id: "1", username: "bot", avatar: "hash-1" },
        { status: 200 }
      );
    }
    if (req.url.startsWith("https://discord.com/api/v10/channels/")) {
      const body = await req.json();
      sends.push({
        url: req.url,
        authorization: req.headers.get("Authorization"),
        body,
      });
      return Response.json({ id: "msg-1", content: body.content }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { service, sends, getAvatarAuth: () => avatarAuth };
}

async function makeWorker(bindings, outboundService) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../worker.js", import.meta.url).pathname,
    compatibilityDate: "2025-11-01",
    durableObjects: { GATEWAY: { className: "Gateway", useSQLite: true } },
    bindings,
    outboundService,
  });
  await mf.ready;
  return mf;
}

async function post(mf, path, bodyObj, key = ADMIN_KEY) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  const init = { method: "POST", headers };
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj);
  const res = await mf.dispatchFetch(ORIGIN + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: res.status, json };
}

let mfA;
let recA;
before(async () => {
  recA = makeOutboundRecorder();
  mfA = await makeWorker(
    {
      DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
      CLAUDE_HOOK_SECRET: HOOK_SECRET,
      ADMIN_KEY,
    },
    recA.service
  );
});
after(async () => {
  await mfA.dispose();
});

test("http: /status shows ichihime idle when only croissand is configured", async () => {
  const res = await mfA.dispatchFetch(ORIGIN + "/status");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.connected, false);
  assert.equal(j.ready, false);
  assert.deepEqual(j.bots.croissand, {
    connected: false,
    ready: false,
    configured: true,
  });
  assert.deepEqual(j.bots.ichihime, {
    connected: false,
    ready: false,
    configured: false,
  });
});

test("http: /send with an unconfigured bot is a 500, unknown bot a 400", async () => {
  const unconf = await post(mfA, "/send", {
    channel_id: "222333444555666777",
    content: "hi",
    bot: "ichihime",
  });
  assert.equal(unconf.status, 500);
  assert.equal(unconf.json.error, "discord bot not configured");
  const unknown = await post(mfA, "/send", {
    channel_id: "222333444555666777",
    content: "hi",
    bot: "bogus",
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "unknown bot");
  const unknownAvatar = await post(mfA, "/avatar", {
    image_base64: PNG_1PX_B64,
    bot: "bogus",
  });
  assert.equal(unknownAvatar.status, 400);
  const unknownConnect = await post(mfA, "/connect", { bot: "bogus" });
  assert.equal(unknownConnect.status, 400);
});

test("http: inherited object names are unknown bots on every admin endpoint", async () => {
  for (const bot of ["__proto__", "constructor", "toString"]) {
    for (const path of ["/send", "/avatar", "/connect"]) {
      const res = await post(mfA, path, { bot, channel_id: "123456789", content: "hi", image_base64: PNG_1PX_B64 });
      assert.equal(res.status, 400, `${path} accepted ${bot}`);
      assert.equal(res.json.error, "unknown bot");
    }
    assert.equal(pure.botConfigured({ undefined: "trap" }, bot), false);
  }
});

let mfB;
let recB;
before(async () => {
  recB = makeOutboundRecorder();
  mfB = await makeWorker(
    {
      DISCORD_BOT_TOKEN: CROISSAND_TOKEN,
      CLAUDE_HOOK_SECRET: HOOK_SECRET,
      DISCORD_BOT_TOKEN_ICHICHIME: ICHIHIME_TOKEN,
      EVENTS_TRIGGER_KEY: TRIGGER_KEY,
      ADMIN_KEY,
    },
    recB.service
  );
});
after(async () => {
  await mfB.dispose();
});

test("http: /send posts with the selected bot's token (default croissand)", async () => {
  const def = await post(mfB, "/send", {
    channel_id: "222333444555666777",
    content: "from croissand",
  });
  assert.equal(def.status, 201);
  assert.equal(recB.sends.at(-1).authorization, `Bot ${CROISSAND_TOKEN}`);
  const ichi = await post(mfB, "/send", {
    channel_id: "222333444555666777",
    content: "from ichihime",
    bot: "ichihime",
  });
  assert.equal(ichi.status, 201);
  assert.equal(recB.sends.at(-1).authorization, "Bot " + ICHIHIME_TOKEN);
});

test("http: /avatar patches the selected bot's avatar", async () => {
  const r = await post(mfB, "/avatar", {
    image_base64: PNG_1PX_B64,
    bot: "ichihime",
  });
  assert.equal(r.status, 200);
  assert.equal(recB.getAvatarAuth(), "Bot " + ICHIHIME_TOKEN);
});

test("http: /connect can target one bot and reports per-bot diagnostics", async () => {
  const r = await post(mfB, "/connect", { bot: "ichihime" });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.connected, "boolean");
  assert.ok(r.json.bots.croissand);
  assert.ok(r.json.bots.ichihime);
  // The recorder refuses the gateway lookup/upgrade, so the targeted
  // connect attempt records a concrete failure instead of hanging.
  assert.equal(typeof r.json.bots.ichihime.lastError, "string");
});

// ---------- storage migration on real (Miniflare) SQLite ----------

const workerSource = readFileSync(
  new URL("../worker.js", import.meta.url),
  "utf8"
);
const migrationFixture =
  workerSource.replace("export default {", "const productionWorker = {")
    .replace('this.ctx.storage.sql.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);',
      'if (this.failMigrationTable === table) throw new Error("synthetic migration failure");\n' +
      'this.ctx.storage.sql.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);') +
  `
export class TestGateway extends Gateway {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/test/seed-legacy') {
   const sql = this.ctx.storage.sql;
   sql.exec('DROP TABLE IF EXISTS outbox');
   sql.exec('DROP TABLE IF EXISTS forward_log');
   sql.exec('CREATE TABLE outbox (request_id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL)');
   sql.exec('CREATE TABLE forward_log (request_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)');
   sql.exec("INSERT INTO outbox (request_id, body, attempts, next_attempt_at, created_at) VALUES ('discord-old', '{}', 2, 111, 100)");
   sql.exec("INSERT INTO forward_log (request_id, completed_at) VALUES ('discord-done', 12345)");
   sql.exec("INSERT INTO kv (key, value) VALUES ('gateway-state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ sessionId: 'legacy-sess', seq: 7, botUserId: '1568508479293890673' }));
   sql.exec("DELETE FROM kv WHERE key IN ('gateway-state:croissand', 'gateway-state:ichihime')");
   return new Response('ok');
  }
  if (path === '/test/migrate') { this.migrateStorage(); return new Response('ok'); }
  if (path === '/test/migrate-fault') {
   this.failMigrationTable = new URL(request.url).searchParams.get('table');
   try { this.migrateStorage(); return Response.json({ error: 'fault did not fire' }, { status: 500 }); }
   catch (e) { return Response.json({ error: e.message,
    outbox: this.ctx.storage.sql.exec('SELECT * FROM outbox').toArray(),
    forwardLog: this.ctx.storage.sql.exec('SELECT * FROM forward_log').toArray(),
    tables: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(r => r.name),
   }); }
   finally { this.failMigrationTable = null; }
  }
  if (path === '/test/inspect') {
   const croissand = this.loadState('croissand');
   const ichihime = this.loadState('ichihime');
   return Response.json({
    outbox: this.ctx.storage.sql.exec('SELECT bot, request_id, attempts FROM outbox ORDER BY request_id').toArray(),
    forwardLog: this.ctx.storage.sql.exec('SELECT bot, request_id, completed_at FROM forward_log').toArray(),
    croissand,
    ichihime,
    kvKeys: this.ctx.storage.sql.exec('SELECT key FROM kv ORDER BY key').toArray().map((r) => r.key),
   });
  }
  return super.fetch(request);
 }
}
export default productionWorker;`;

let mfM;
let stubM;
before(async () => {
  mfM = new Miniflare({
    workers: [
      {
        name: "gateway",
        modules: true,
        script: migrationFixture,
        compatibilityDate: "2025-11-01",
        durableObjects: {
          GATEWAY: { className: "TestGateway", useSQLite: true },
        },
      },
    ],
  });
  const ns = await mfM.getDurableObjectNamespace("GATEWAY");
  stubM = ns.get(ns.idFromName("global"));
});
after(async () => {
  await mfM.dispose();
});

test("migration: pre-upgrade tables and state gain the bot dimension in place", async () => {
  await stubM.fetch("https://local/test/seed-legacy");
  await stubM.fetch("https://local/test/migrate");
  const j = await (
    await stubM.fetch("https://local/test/inspect")
  ).json();
  // Existing rows survive, attributed to croissand.
  assert.deepEqual(j.outbox, [
    { bot: "croissand", request_id: "discord-old", attempts: 2 },
  ]);
  assert.deepEqual(j.forwardLog, [
    { bot: "croissand", request_id: "discord-done", completed_at: 12345 },
  ]);
  // The legacy state row was adopted by croissand; ichihime is fresh.
  assert.equal(j.croissand.sessionId, "legacy-sess");
  assert.equal(j.croissand.seq, 7);
  assert.equal(j.ichihime.sessionId, null);
  assert.ok(j.kvKeys.includes("gateway-state:croissand"));
  assert.ok(!j.kvKeys.includes("gateway-state"));
});

test("migration: a failure after either DROP rolls both tables back and retries without loss", async () => {
  for (const table of ["outbox", "forward_log"]) {
    await stubM.fetch("https://local/test/seed-legacy");
    const failed = await (await stubM.fetch(`https://local/test/migrate-fault?table=${table}`)).json();
    assert.equal(failed.error, "synthetic migration failure");
    assert.deepEqual(failed.outbox, [{ request_id: "discord-old", body: "{}", attempts: 2,
      next_attempt_at: 111, created_at: 100 }]);
    assert.deepEqual(failed.forwardLog, [{ request_id: "discord-done", completed_at: 12345 }]);
    assert.ok(!failed.tables.includes("outbox_v2"));
    assert.ok(!failed.tables.includes("forward_log_v2"));
    await stubM.fetch("https://local/test/migrate");
    await stubM.fetch("https://local/test/migrate");
    const retried = await (await stubM.fetch("https://local/test/inspect")).json();
    assert.deepEqual(retried.outbox, [{ bot: "croissand", request_id: "discord-old", attempts: 2 }]);
    assert.deepEqual(retried.forwardLog, [{ bot: "croissand", request_id: "discord-done", completed_at: 12345 }]);
    assert.equal(retried.croissand.sessionId, "legacy-sess");
  }
});

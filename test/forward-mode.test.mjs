// Tests for the FORWARD_MODE forward dispatch (worker.js):
// - "claude-hook" (default): signed Standard Webhooks POST to
//   dots-events /claude-hook, as before.
// - "trigger": unsigned POST to dots-events /trigger with a Bearer
//   EVENTS_TRIGGER_KEY, for second-bot deployments. A non-429 4xx is a
//   final failure there; 5xx / 429 / network errors retry.
// Pure helpers are imported through the same source transform as
// gateway.test.mjs; the Durable Object's deliverOutbox is exercised
// with a fake in-memory SQL store and a stubbed global fetch.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOOK_SECRET = "whsec_" + randomBytes(32).toString("base64");
const TRIGGER_KEY = "test-trigger-key";
const BODY = JSON.stringify({
  text: "[discord channel:1 guild:- author:alice]\nhello",
  topic: "discord",
  request_id: "discord-42",
});

let pure;
let DS; // DEFAULT_GATEWAY_STATE, reached via __testHooks()
before(async () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const stubbed = src.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  );
  assert.notEqual(stubbed, src, "cloudflare:workers import not found to stub");
  const dir = mkdtempSync(join(tmpdir(), "discord-gateway-forward-test-"));
  const file = join(dir, "worker-under-test.mjs");
  writeFileSync(file, stubbed);
  pure = await import(pathToFileURL(file).href);
  DS = pure.__testHooks().DEFAULT_GATEWAY_STATE;
});

// A fetch stand-in that records its call and returns a canned response
// (or throws, when `respond` is an Error).
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

// ---------- mode dispatch (pure) ----------

test("forwardMode: unset or unknown values select claude-hook", () => {
  assert.equal(pure.forwardMode({}), "claude-hook");
  assert.equal(pure.forwardMode({ FORWARD_MODE: "claude-hook" }), "claude-hook");
  assert.equal(pure.forwardMode({ FORWARD_MODE: "bogus" }), "claude-hook");
  assert.equal(pure.forwardMode({ FORWARD_MODE: "trigger" }), "trigger");
  assert.equal(pure.forwardMode(undefined), "claude-hook");
});

test("forwardSecret: the credential follows the mode", () => {
  const env = { CLAUDE_HOOK_SECRET: "hook", EVENTS_TRIGGER_KEY: "trig" };
  assert.equal(pure.forwardSecret(env), "hook");
  assert.equal(pure.forwardSecretName(env), "CLAUDE_HOOK_SECRET");
  assert.equal(
    pure.forwardSecret({ ...env, FORWARD_MODE: "trigger" }),
    "trig"
  );
  assert.equal(
    pure.forwardSecretName({ ...env, FORWARD_MODE: "trigger" }),
    "EVENTS_TRIGGER_KEY"
  );
  assert.equal(pure.forwardSecret({ FORWARD_MODE: "trigger" }), undefined);
  assert.equal(pure.forwardSecret({}), undefined);
});

test("isConfigured: trigger deployments need the trigger key, not the hook secret", () => {
  const gateway = Object.create(pure.Gateway.prototype);
  gateway.env = { DISCORD_BOT_TOKEN: "t", CLAUDE_HOOK_SECRET: "s" };
  assert.equal(gateway.isConfigured(), true);
  gateway.env = {
    DISCORD_BOT_TOKEN: "t",
    FORWARD_MODE: "trigger",
    EVENTS_TRIGGER_KEY: "k",
  };
  assert.equal(gateway.isConfigured(), true);
  gateway.env = {
    DISCORD_BOT_TOKEN: "t",
    FORWARD_MODE: "trigger",
    CLAUDE_HOOK_SECRET: "s",
  };
  assert.equal(gateway.isConfigured(), false);
  gateway.env = { DISCORD_BOT_TOKEN: "t" };
  assert.equal(gateway.isConfigured(), false);
});

// ---------- attemptForward: claude-hook mode ----------

test("attemptForward: default mode posts a signed webhook to /claude-hook", async () => {
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env: { CLAUDE_HOOK_SECRET: HOOK_SECRET },
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.deepEqual(result, {
    delivered: true,
    final: false,
    error: null,
    retryAfterMs: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/claude-hook");
  const headers = calls[0].init.headers;
  assert.equal(headers["webhook-id"], "discord-42");
  assert.ok(headers["webhook-timestamp"]);
  assert.ok(headers["webhook-signature"]);
  assert.equal(headers.Authorization, undefined);
  assert.equal(calls[0].init.body, BODY);
  assert.equal(
    await pure.verifyBody(
      HOOK_SECRET,
      "discord-42",
      headers["webhook-timestamp"],
      BODY,
      headers["webhook-signature"]
    ),
    true
  );
});

test("attemptForward: claude-hook failures are never final (retry to the cap)", async () => {
  for (const status of [400, 403, 500]) {
    const { impl } = fakeFetch(new Response("no", { status }));
    const result = await pure.attemptForward({
      env: { CLAUDE_HOOK_SECRET: HOOK_SECRET },
      fetchImpl: impl,
      requestId: "discord-42",
      body: BODY,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.final, false);
    assert.equal(result.error, `claude-hook HTTP ${status} for discord-42`);
  }
  const { impl } = fakeFetch(new Error("network down"));
  const result = await pure.attemptForward({
    env: { CLAUDE_HOOK_SECRET: HOOK_SECRET },
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.deepEqual(result, {
    delivered: false,
    final: false,
    error: "claude-hook request failed for discord-42",
    retryAfterMs: null,
  });
});

// ---------- attemptForward: trigger mode ----------

test("attemptForward: trigger mode posts unsigned with the Bearer key to /trigger", async () => {
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env: { FORWARD_MODE: "trigger", EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.deepEqual(result, {
    delivered: true,
    final: false,
    error: null,
    retryAfterMs: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/trigger");
  const headers = calls[0].init.headers;
  assert.equal(headers.Authorization, `Bearer ${TRIGGER_KEY}`);
  assert.equal(headers["webhook-id"], undefined);
  assert.equal(headers["webhook-timestamp"], undefined);
  assert.equal(headers["webhook-signature"], undefined);
  assert.equal(calls[0].init.body, BODY);
});

test("attemptForward: trigger non-429 4xx is final, 5xx and network errors retry", async () => {
  const env = { FORWARD_MODE: "trigger", EVENTS_TRIGGER_KEY: TRIGGER_KEY };
  for (const status of [400, 401, 403, 404, 422]) {
    const { impl } = fakeFetch(new Response("no", { status }));
    const result = await pure.attemptForward({
      env,
      fetchImpl: impl,
      requestId: "discord-42",
      body: BODY,
    });
    assert.equal(result.delivered, false, `status ${status}`);
    assert.equal(result.final, true, `status ${status}`);
    assert.equal(result.error, `trigger HTTP ${status} for discord-42`);
  }
  for (const status of [500, 502, 503]) {
    const { impl } = fakeFetch(new Response("no", { status }));
    const result = await pure.attemptForward({
      env,
      fetchImpl: impl,
      requestId: "discord-42",
      body: BODY,
    });
    assert.equal(result.delivered, false, `status ${status}`);
    assert.equal(result.final, false, `status ${status}`);
  }
  const { impl } = fakeFetch(new Error("network down"));
  const result = await pure.attemptForward({
    env,
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.deepEqual(result, {
    delivered: false,
    final: false,
    error: "trigger request failed for discord-42",
    retryAfterMs: null,
  });
});

test("attemptForward: trigger 429 retries and surfaces the delay hint", async () => {
  const env = { FORWARD_MODE: "trigger", EVENTS_TRIGGER_KEY: TRIGGER_KEY };
  const fromHeader = fakeFetch(
    new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "2" },
    })
  );
  const r1 = await pure.attemptForward({
    env,
    fetchImpl: fromHeader.impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(r1.delivered, false);
  assert.equal(r1.final, false);
  assert.equal(r1.retryAfterMs, 2000);

  const fromBody = fakeFetch(
    new Response(JSON.stringify({ retry_after: 3 }), { status: 429 })
  );
  const r2 = await pure.attemptForward({
    env,
    fetchImpl: fromBody.impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(r2.delivered, false);
  assert.equal(r2.final, false);
  assert.equal(r2.retryAfterMs, 3000);
});

// ---------- deliverOutbox with a fake SQL store ----------

// Minimal in-memory stand-in for the DO's SQLite tables, keyed on the
// exact statements deliverOutbox and its helpers issue.
function fakeSql(outboxRows) {
  const outbox = new Map(outboxRows.map((r) => [r.request_id, { ...r }]));
  const forwardLog = new Map();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT request_id, body, attempts FROM outbox")) {
      const now = params[0];
      const rows = [...outbox.values()]
        .filter((r) => r.next_attempt_at <= now)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, 10);
      return { toArray: () => rows };
    }
    if (sql.startsWith("SELECT MIN(next_attempt_at)")) {
      const vals = [...outbox.values()].map((r) => r.next_attempt_at);
      return { toArray: () => [{ m: vals.length ? Math.min(...vals) : null }] };
    }
    if (sql.startsWith("DELETE FROM outbox")) {
      outbox.delete(params[0]);
      return { toArray: () => [] };
    }
    if (sql.startsWith("INSERT OR REPLACE INTO forward_log")) {
      forwardLog.set(params[0], params[1]);
      return { toArray: () => [] };
    }
    if (sql.startsWith("UPDATE outbox")) {
      const row = outbox.get(params[2]);
      if (row) {
        row.attempts = params[0];
        row.next_attempt_at = params[1];
      }
      return { toArray: () => [] };
    }
    if (sql.startsWith("DELETE FROM forward_log")) {
      for (const [id, at] of forwardLog) {
        if (at < params[0]) forwardLog.delete(id);
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

const dueRow = () => ({
  request_id: "discord-42",
  body: BODY,
  attempts: 0,
  next_attempt_at: Date.now() - 1,
  created_at: Date.now() - 2,
});

async function withGlobalFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("outbox: trigger mode without the trigger key suspends with a mode-specific error", async () => {
  const store = fakeSql([dueRow()]);
  const gateway = gatewayWithStore({ FORWARD_MODE: "trigger" }, store);
  await gateway.deliverOutbox();
  assert.equal(
    gateway.getState().lastForwardError,
    "missing EVENTS_TRIGGER_KEY"
  );
  assert.equal(gateway.getState().nextOutboxAt, null);
  assert.equal(store.outbox.size, 1); // row kept, not deleted
});

test("outbox: trigger 4xx drops the row and logs the request_id as failed", async () => {
  const store = fakeSql([dueRow()]);
  const gateway = gatewayWithStore(
    { FORWARD_MODE: "trigger", EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    store
  );
  const { impl, calls } = fakeFetch(new Response("bad request", { status: 400 }));
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/trigger");
  assert.equal(store.outbox.size, 0);
  assert.ok(store.forwardLog.has("discord-42"));
  assert.equal(gateway.getState().droppedForwardCount, 1);
  assert.equal(gateway.getState().forwardedCount, 0);
  assert.equal(
    gateway.getState().lastForwardError,
    "trigger HTTP 400 for discord-42"
  );
});

test("outbox: trigger 5xx keeps the row queued for a retry", async () => {
  const store = fakeSql([dueRow()]);
  const gateway = gatewayWithStore(
    { FORWARD_MODE: "trigger", EVENTS_TRIGGER_KEY: TRIGGER_KEY },
    store
  );
  const { impl } = fakeFetch(new Response("unavailable", { status: 503 }));
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(store.outbox.size, 1);
  const row = store.outbox.get("discord-42");
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > Date.now());
  assert.equal(store.forwardLog.size, 0);
  assert.equal(gateway.getState().droppedForwardCount, 0);
  assert.equal(gateway.getState().forwardedCount, 0);
});

test("outbox: claude-hook success still forwards, logs, and counts (regression)", async () => {
  const store = fakeSql([dueRow()]);
  const gateway = gatewayWithStore(
    { CLAUDE_HOOK_SECRET: HOOK_SECRET },
    store
  );
  const { impl, calls } = fakeFetch(okJson());
  await withGlobalFetch(impl, () => gateway.deliverOutbox());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/claude-hook");
  assert.ok(calls[0].init.headers["webhook-signature"]);
  assert.equal(store.outbox.size, 0);
  assert.ok(store.forwardLog.has("discord-42"));
  assert.equal(gateway.getState().forwardedCount, 1);
  assert.equal(gateway.getState().lastForwardError, null);
});

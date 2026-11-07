// Tests for discord-gateway.
// - Pure protocol / filtering / signing logic is imported from worker.js
//   through a source transform that stubs the "cloudflare:workers"
//   import (Node cannot resolve that module); everything tested this way
//   is the exact code the Worker runs.
// - HTTP behavior (admin auth on /send, /status shape, Discord REST
//   pass-through with content truncation) runs on Miniflare with a
//   mocked outbound service, fully locally.
// The real Discord Gateway socket lifecycle is NOT exercised here:
// Miniflare cannot stand in for Discord's gateway, so the op-code
// handling is covered at the pure-function level instead (see
// handleGatewayPayload / heartbeatDecision / reconnectDecisionForClose).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";

const ORIGIN = "https://discord-gateway.test";
const ADMIN_KEY = "test-admin-key";
const BOT_TOKEN = "test-bot-token"; // synthetic fixture, not a real token
const HOOK_SECRET = "whsec_" + randomBytes(32).toString("base64");

// ---------- load worker.js pure exports under Node ----------

let pure;
let DS; // DEFAULT_GATEWAY_STATE, reached via __testHooks()
before(async () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const stubbed = src.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  );
  assert.notEqual(stubbed, src, "cloudflare:workers import not found to stub");
  const dir = mkdtempSync(join(tmpdir(), "discord-gateway-test-"));
  const file = join(dir, "worker-under-test.mjs");
  writeFileSync(file, stubbed);
  pure = await import(pathToFileURL(file).href);
  DS = pure.__testHooks().DEFAULT_GATEWAY_STATE;
  assert.equal(pure.__testHooks().GATEWAY_INTENTS, 37377);
});

// ---------- Standard Webhooks signing ----------

test("signBody matches the Standard Webhooks construction used by dots-kick-events", async () => {
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const msgId = "discord-1234567890";
  const ts = "1762470000";
  const body = JSON.stringify({ text: "hello", topic: "discord", request_id: msgId });
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected =
    "v1," +
    createHmac("sha256", keyBytes).update(`${msgId}.${ts}.${body}`).digest("base64");
  const actual = await pure.signBody(secret, msgId, ts, body);
  assert.equal(actual, expected);
  assert.equal(await pure.verifyBody(secret, msgId, ts, body, actual), true);
  assert.equal(
    await pure.verifyBody(secret, msgId, ts, body + " ", actual),
    false
  );
});

// ---------- MESSAGE_CREATE filtering ----------

const BOT_ID = "999888777666555444";

function message(overrides = {}) {
  return {
    id: "111222333444555666",
    channel_id: "222333444555666777",
    guild_id: "333444555666777888",
    content: "hello",
    author: { id: "444555666777888999", username: "alice", bot: false },
    mentions: [],
    ...overrides,
  };
}

test("filter: the bot's own messages are ignored", () => {
  const m = message({
    author: { id: BOT_ID, username: "gateway-bot", bot: true },
    mentions: [{ id: BOT_ID }],
    content: `<@${BOT_ID}> hi`,
  });
  assert.equal(pure.shouldForwardMessage(m, BOT_ID), false);
  assert.equal(pure.buildForwardRequest(m, BOT_ID), null);
});

test("filter: other bots' messages are ignored", () => {
  const m = message({
    author: { id: "555666777888999000", username: "other-bot", bot: true },
    mentions: [{ id: BOT_ID }],
    content: `<@${BOT_ID}> hi`,
  });
  assert.equal(pure.shouldForwardMessage(m, BOT_ID), false);
});

test("filter: DMs are forwarded, with the header line and request_id", () => {
  const m = message({ guild_id: undefined, content: "  dm text  " });
  const req = pure.buildForwardRequest(m, BOT_ID);
  assert.ok(req);
  assert.equal(req.topic, "discord");
  assert.equal(req.request_id, "discord-111222333444555666");
  assert.equal(
    req.text,
    "[discord channel:222333444555666777 guild:- author:alice]\ndm text"
  );
});

test("filter: guild messages mentioning the bot are forwarded, mention stripped", () => {
  const m = message({
    content: `<@${BOT_ID}> please check this`,
    mentions: [{ id: BOT_ID, username: "gateway-bot" }],
  });
  assert.equal(pure.shouldForwardMessage(m, BOT_ID), true);
  const req = pure.buildForwardRequest(m, BOT_ID);
  assert.ok(req);
  assert.equal(
    req.text,
    "[discord channel:222333444555666777 guild:333444555666777888 author:alice]\nplease check this"
  );
  // The <@!id> nickname-mention form is recognized and stripped too.
  const m2 = message({ content: `<@!${BOT_ID}> ping` });
  const req2 = pure.buildForwardRequest(m2, BOT_ID);
  assert.ok(req2);
  assert.ok(req2.text.endsWith("]\nping"));
});

test("filter: plain guild messages without a mention are ignored", () => {
  const m = message({ content: "just chatting" });
  assert.equal(pure.shouldForwardMessage(m, BOT_ID), false);
  assert.equal(pure.buildForwardRequest(m, BOT_ID), null);
});

test("filter: a mention with no remaining text forwards nothing", () => {
  const m = message({
    content: `<@${BOT_ID}>`,
    mentions: [{ id: BOT_ID }],
  });
  assert.equal(pure.buildForwardRequest(m, BOT_ID), null);
});

// ---------- gateway protocol decisions ----------

const NOW = 1762470000000;

test("protocol: Hello on a fresh session decides Identify and arms the heartbeat", () => {
  const { state, actions } = pure.handleGatewayPayload(
    DS,
    { op: 10, d: { heartbeat_interval: 41250 } },
    { now: NOW }
  );
  assert.deepEqual(
    actions.map((a) => a.type),
    ["identify", "schedule_alarm"]
  );
  assert.equal(state.heartbeatIntervalMs, 41250);
  assert.equal(state.nextHeartbeatAt, NOW + 41250);
  assert.equal(state.helloReceived, true);
});

test("protocol: Hello with a stored session decides Resume", () => {
  const start = {
    ...DS,
    sessionId: "sess-1",
    seq: 42,
    resumeMode: "resume",
    resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
  };
  const { actions } = pure.handleGatewayPayload(
    start,
    { op: 10, d: { heartbeat_interval: 41250 } },
    { now: NOW }
  );
  assert.equal(actions[0].type, "resume");
});

test("protocol: READY stores the session, resume URL and bot identity", () => {
  const { state } = pure.handleGatewayPayload(
    DS,
    {
      op: 0,
      s: 1,
      t: "READY",
      d: {
        session_id: "sess-9",
        resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
        user: { id: BOT_ID, username: "gateway-bot" },
      },
    },
    { now: NOW }
  );
  assert.equal(state.sessionId, "sess-9");
  assert.equal(state.resumeGatewayUrl, "wss://gateway-us-east1-b.discord.gg");
  assert.equal(state.botUserId, BOT_ID);
  assert.equal(state.botUsername, "gateway-bot");
  assert.equal(state.ready, true);
  assert.equal(state.seq, 1);
  assert.equal(state.resumeMode, "resume");
});

test("protocol: a MESSAGE_CREATE dispatch updates seq and yields a forward action", () => {
  const start = {
    ...DS,
    botUserId: BOT_ID,
    ready: true,
  };
  const { state, actions } = pure.handleGatewayPayload(
    start,
    { op: 0, s: 7, t: "MESSAGE_CREATE", d: message({ guild_id: undefined }) },
    { now: NOW }
  );
  assert.equal(state.seq, 7);
  const forwards = actions.filter((a) => a.type === "forward");
  assert.equal(forwards.length, 1);
  assert.equal(forwards[0].request.request_id, "discord-111222333444555666");
});

test("protocol: Heartbeat ACK clears the awaiting flag; op 1 requests a heartbeat", () => {
  const start = { ...DS, awaitingHeartbeatAck: true };
  const ack = pure.handleGatewayPayload(start, { op: 11 }, { now: NOW });
  assert.equal(ack.state.awaitingHeartbeatAck, false);
  const req = pure.handleGatewayPayload(
    DS,
    { op: 1, d: null },
    { now: NOW }
  );
  assert.deepEqual(
    req.actions.map((a) => a.type),
    ["heartbeat"]
  );
});

test("protocol: Reconnect (op 7) closes the socket and schedules a resume", () => {
  const start = { ...DS, sessionId: "sess-1", ready: true };
  const { state, actions } = pure.handleGatewayPayload(start, { op: 7 }, { now: NOW });
  assert.equal(state.resumeMode, "resume");
  assert.equal(state.expectingClose, true);
  assert.equal(state.nextReconnectAt, NOW + 1000);
  assert.ok(actions.some((a) => a.type === "close_socket"));
});

test("protocol: Invalid Session resumable keeps the session; non-resumable clears it", () => {
  const start = {
    ...DS,
    sessionId: "sess-1",
    seq: 5,
    resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
  };
  const yes = pure.handleGatewayPayload(start, { op: 9, d: true }, { now: NOW });
  assert.equal(yes.state.resumeMode, "resume");
  assert.equal(yes.state.sessionId, "sess-1");
  assert.equal(yes.state.nextReconnectAt, NOW + 1000);

  const no = pure.handleGatewayPayload(start, { op: 9, d: false }, { now: NOW });
  assert.equal(no.state.resumeMode, "identify");
  assert.equal(no.state.sessionId, null);
  assert.equal(no.state.seq, null);
  assert.equal(no.state.resumeGatewayUrl, null);
  assert.equal(no.state.nextReconnectAt, NOW + 3000);
});

test("heartbeat decision: a missed ACK means reconnect; otherwise send and re-arm", () => {
  const base = {
    ...DS,
    helloReceived: true,
    heartbeatIntervalMs: 1000,
    seq: 3,
  };
  const missed = pure.heartbeatDecision(
    { ...base, awaitingHeartbeatAck: true },
    NOW
  );
  assert.equal(missed.action, "reconnect");
  const sent = pure.heartbeatDecision(
    { ...base, awaitingHeartbeatAck: false },
    NOW
  );
  assert.equal(sent.action, "send_heartbeat");
  assert.deepEqual(sent.payload, { op: 1, d: 3 });
  assert.equal(sent.state.awaitingHeartbeatAck, true);
  assert.equal(sent.state.nextHeartbeatAt, NOW + 1000);
});

test("close decision: fatal codes clear the session with a long backoff", () => {
  const start = {
    ...DS,
    sessionId: "sess-1",
    seq: 9,
    resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
  };
  const fatal = pure.reconnectDecisionForClose(start, 4004, NOW);
  assert.equal(fatal.clearSession, true);
  assert.equal(fatal.state.sessionId, null);
  assert.equal(fatal.delayMs, 300000);

  const invalidSeq = pure.reconnectDecisionForClose(start, 4007, NOW);
  assert.equal(invalidSeq.clearSession, true);
  assert.equal(invalidSeq.delayMs, 1000);

  const transient = pure.reconnectDecisionForClose(start, 4000, NOW);
  assert.equal(transient.clearSession, false);
  assert.equal(transient.state.sessionId, "sess-1");
  assert.equal(transient.state.resumeMode, "resume");
  assert.equal(transient.delayMs, 1000);
});

test("pure: close code 4014 points at the Developer Portal intent fix", () => {
  const d = pure.reconnectDecisionForClose(DS, 4014, NOW);
  assert.equal(d.clearSession, true);
  assert.match(d.state.lastError, /4014/);
  assert.match(d.state.lastError, /MESSAGE CONTENT/);
  assert.match(d.state.lastError, /Developer Portal/);
});

test("pure: splitDiscordContent keeps short text whole and splits long text on boundaries", () => {
  assert.deepEqual(pure.splitDiscordContent("hello"), ["hello"]);
  assert.deepEqual(pure.splitDiscordContent(""), []);
  const two = pure.splitDiscordContent("a".repeat(2500));
  assert.equal(two.length, 2);
  assert.equal(two[0].length, 2000);
  assert.equal(two[1].length, 500);
  // Prefers a newline boundary over a hard cut.
  const withBreaks = "line\n".repeat(600); // 3000 chars
  const parts = pure.splitDiscordContent(withBreaks);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 2000);
  assert.ok(parts[0].endsWith("line")); // cut happened at a newline
  assert.equal(parts.join("").split("line").length - 1, 600); // nothing lost
});

test("pure: splitDiscordContent caps the fan-out with a truncation notice", () => {
  const parts = pure.splitDiscordContent("b".repeat(2000 * 25), 2000, 10);
  assert.equal(parts.length, 10);
  for (const p of parts) assert.ok(p.length <= 2000);
  assert.match(parts[9], /truncated/);
});

test("pure: splitDiscordContent never splits a surrogate pair", () => {
  const text = "a".repeat(1999) + "\u{1F600}" + "b".repeat(100);
  const parts = pure.splitDiscordContent(text);
  assert.equal(parts.length, 2);
  assert.ok(!/[\uD800-\uDBFF]$/.test(parts[0]));
  assert.ok(parts[1].startsWith("\u{1F600}"));
});

test("pure: parseRetryAfterSeconds prefers the body, then headers", () => {
  const headers = new Headers({
    "retry-after": "7",
    "x-ratelimit-reset-after": "9",
  });
  assert.equal(pure.parseRetryAfterSeconds({ body: { retry_after: 1.5 }, headers }), 1.5);
  assert.equal(pure.parseRetryAfterSeconds({ body: null, headers }), 7);
  assert.equal(
    pure.parseRetryAfterSeconds({
      body: null,
      headers: new Headers({ "x-ratelimit-reset-after": "2.25" }),
    }),
    2.25
  );
  assert.equal(pure.parseRetryAfterSeconds({ body: null, headers: new Headers() }), null);
  assert.equal(pure.parseRetryAfterSeconds({}), null);
});

test("pure: eventSilenceDecision reconnects only a ready, long-silent socket", () => {
  const max = pure.__testHooks().MAX_EVENT_SILENCE_MS;
  assert.equal(max, 4 * 60 * 60 * 1000);
  const silent = { ...DS, ready: true, lastDispatchAt: NOW - max - 1 };
  assert.equal(pure.eventSilenceDecision(silent, NOW).action, "reconnect");
  const fresh = { ...DS, ready: true, lastDispatchAt: NOW - 1000 };
  assert.equal(pure.eventSilenceDecision(fresh, NOW).action, "none");
  const notReady = { ...DS, ready: false, lastDispatchAt: NOW - max - 1 };
  assert.equal(pure.eventSilenceDecision(notReady, NOW).action, "none");
  const neverDispatched = { ...DS, ready: true, lastDispatchAt: null };
  assert.equal(pure.eventSilenceDecision(neverDispatched, NOW).action, "none");
  // READY itself stamps the dispatch clock via handleGatewayPayload.
  const ready = pure.handleGatewayPayload(DS, {
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: "s", resume_gateway_url: "wss://r", user: { id: "1", username: "b" } },
  }, { now: NOW });
  assert.equal(ready.state.lastDispatchAt, NOW);
});

// ---------- HTTP surface on Miniflare ----------

let mf;
let discordSends = [];
let lastDiscordSend = null;
const RATE_LIMIT_CHANNEL = "999888777666555444";
let rateLimitHits = 0;

async function outboundService(req) {
  if (req.url.startsWith("https://discord.com/api/v10/channels/")) {
    const body = await req.json();
    const record = {
      url: req.url,
      authorization: req.headers.get("Authorization"),
      body,
    };
    discordSends.push(record);
    lastDiscordSend = record;
    // Scripted rate limit: the first send to this channel gets a 429
    // with a tiny retry_after, later sends succeed.
    if (req.url.includes(RATE_LIMIT_CHANNEL) && rateLimitHits === 0) {
      rateLimitHits += 1;
      return Response.json(
        { message: "You are being rate limited.", retry_after: 0.01, global: false },
        { status: 429 }
      );
    }
    return Response.json(
      { id: "msg-" + discordSends.length, channel_id: body.channel_id ?? null, content: body.content },
      { status: 201 }
    );
  }
  return new Response("not found", { status: 404 });
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../worker.js", import.meta.url).pathname,
    compatibilityDate: "2025-11-01",
    durableObjects: { GATEWAY: { className: "Gateway", useSQLite: true } },
    bindings: {
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      CLAUDE_HOOK_SECRET: HOOK_SECRET,
      ADMIN_KEY,
    },
    outboundService,
  });
  await mf.ready;
});
after(async () => {
  await mf.dispose();
});

async function send(bodyObj, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  const res = await mf.dispatchFetch(ORIGIN + "/send", {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: res.status, json };
}

test("http: /status is public and exposes exactly {connected, ready}", async () => {
  const res = await mf.dispatchFetch(ORIGIN + "/status");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j).sort(), ["connected", "ready"]);
  assert.equal(j.connected, false);
  assert.equal(j.ready, false);
});

test("http: /send rejects missing and wrong admin keys with 401", async () => {
  const body = { channel_id: "222333444555666777", content: "hi" };
  assert.equal((await send(body, null)).status, 401);
  assert.equal((await send(body, "not-the-key")).status, 401);
  const viaHeader = await mf.dispatchFetch(ORIGIN + "/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trigger-Key": ADMIN_KEY },
    body: JSON.stringify(body),
  });
  assert.equal(viaHeader.status, 201);
});

test("http: /connect rejects a missing admin key with 401", async () => {
  const res = await mf.dispatchFetch(ORIGIN + "/connect", { method: "POST" });
  assert.equal(res.status, 401);
});

test("http: /send posts to the Discord channel with the bot token and returns its response", async () => {
  const r = await send(
    { channel_id: "222333444555666777", content: "reply text" },
    ADMIN_KEY
  );
  assert.equal(r.status, 201);
  assert.equal(r.json.content, "reply text");
  assert.equal(
    lastDiscordSend.url,
    "https://discord.com/api/v10/channels/222333444555666777/messages"
  );
  assert.equal(lastDiscordSend.authorization, "Bot " + BOT_TOKEN);
  assert.equal(lastDiscordSend.body.content, "reply text");
});

test("http: /send splits content over 2000 characters into multiple messages (Hermes pattern)", async () => {
  discordSends = [];
  const r = await send(
    { channel_id: "222333444555666777", content: "x".repeat(2500) },
    ADMIN_KEY
  );
  assert.equal(r.status, 201);
  assert.equal(r.json.chunks, 2);
  assert.equal(r.json.message_ids.length, 2);
  assert.equal(discordSends.length, 2);
  assert.equal(discordSends[0].body.content.length, 2000);
  assert.equal(discordSends[1].body.content.length, 500);
});

test("http: /send retries after a Discord 429 honoring retry_after", async () => {
  discordSends = [];
  rateLimitHits = 0;
  const r = await send(
    { channel_id: RATE_LIMIT_CHANNEL, content: "after the limit" },
    ADMIN_KEY
  );
  assert.equal(r.status, 201);
  assert.equal(r.json.content, "after the limit");
  assert.equal(discordSends.length, 2); // 429 attempt + successful retry
});

test("http: /send validates channel_id and content", async () => {
  assert.equal(
    (await send({ channel_id: "not-a-channel", content: "hi" }, ADMIN_KEY)).status,
    400
  );
  assert.equal(
    (await send({ channel_id: "222333444555666777", content: "  " }, ADMIN_KEY)).status,
    400
  );
});

// tako (たこ), the third bot on the shared Gateway object.
// Same isolation as croissand and ichihime: own token, own forward
// target, own connection and outbox rows. Unset secrets leave it idle.
// Inbound uses the existing mention/DM rules plus tako's name calls.
// Outbound forwards are an unsigned HTTPS webhook (trigger-style
// retry classification), not dots-events.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";

const TAKO_NAMES = ["たこ", "たこ · 秘書", "tako"];
const TAKO_ID = "777000000000000001";
const OWNER_ID = "333933401314951168";
const CROISSAND_ID = "1568508479293890673";
const ICHIHIME_ID = "1568548424519913482";
const WEBHOOK_URL = "https://grok-bot.example/hooks/tako";
const WEBHOOK_KEY = "synthetic-tako-webhook-key";
const TAKO_TOKEN = "synthetic-tako-token";
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
let DS;
before(async () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const stubbed = src.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  );
  assert.notEqual(stubbed, src, "cloudflare:workers import not found to stub");
  const dir = mkdtempSync(join(tmpdir(), "discord-gateway-tako-test-"));
  const file = join(dir, "worker-under-test.mjs");
  writeFileSync(file, stubbed);
  pure = await import(pathToFileURL(file).href);
  DS = pure.__testHooks().DEFAULT_GATEWAY_STATE;
});

function message(overrides = {}) {
  return {
    id: "222333444555666777",
    channel_id: "111222333444555666",
    guild_id: "413624636673359882",
    content: "hello",
    author: { id: OWNER_ID, username: "g_kari", bot: false },
    mentions: [],
    ...overrides,
  };
}

function takoEnv(extra = {}) {
  return {
    DISCORD_BOT_TOKEN_TAKO: TAKO_TOKEN,
    TAKO_WEBHOOK_URL: WEBHOOK_URL,
    TAKO_WEBHOOK_KEY: WEBHOOK_KEY,
    ...extra,
  };
}

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (respond instanceof Error) throw respond;
    return typeof respond === "function" ? respond(url, init) : respond;
  };
  return { impl, calls };
}

const okJson = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

// ---------- registry / configured ----------

test("registry: tako is the third hosted bot and stays quiet until token, url, and key are set", () => {
  const hooks = pure.__testHooks();
  assert.deepEqual(hooks.BOT_KEYS, ["croissand", "ichihime", "tako"]);
  const tako = hooks.BOT_CONFIGS.tako;
  assert.equal(tako.tokenEnv, "DISCORD_BOT_TOKEN_TAKO");
  assert.equal(tako.forwardMode, "webhook");
  assert.equal(tako.forwardSecretEnv, "TAKO_WEBHOOK_KEY");
  assert.equal(tako.webhookUrlEnv, "TAKO_WEBHOOK_URL");
  assert.equal(tako.webhookAuthHeaderEnv, "TAKO_WEBHOOK_AUTH_HEADER");
  assert.deepEqual(tako.names, TAKO_NAMES);
  assert.equal(tako.userId ?? null, null);

  assert.equal(pure.botConfigured(takoEnv(), "tako"), true);
  assert.equal(pure.botConfigured({}, "tako"), false);
  assert.equal(
    pure.botConfigured({ DISCORD_BOT_TOKEN_TAKO: TAKO_TOKEN }, "tako"),
    false
  );
  assert.equal(
    pure.botConfigured(
      { DISCORD_BOT_TOKEN_TAKO: TAKO_TOKEN, TAKO_WEBHOOK_KEY: WEBHOOK_KEY },
      "tako"
    ),
    false
  );
  assert.equal(
    pure.botConfigured(
      { DISCORD_BOT_TOKEN_TAKO: TAKO_TOKEN, TAKO_WEBHOOK_URL: WEBHOOK_URL },
      "tako"
    ),
    false
  );
  assert.equal(
    pure.botConfigured(
      takoEnv({ TAKO_WEBHOOK_URL: "http://grok-bot.example/hooks/tako" }),
      "tako"
    ),
    false
  );
  assert.equal(
    pure.botConfigured(
      takoEnv({ TAKO_WEBHOOK_URL: "https://user:pass@grok-bot.example/hooks/tako" }),
      "tako"
    ),
    false
  );
  assert.equal(
    pure.botConfigured(takoEnv({ TAKO_WEBHOOK_AUTH_HEADER: "X-Webhook-Key" }), "tako"),
    true
  );
  assert.equal(
    pure.botConfigured(takoEnv({ TAKO_WEBHOOK_AUTH_HEADER: "Bad Header" }), "tako"),
    false
  );
  assert.equal(
    pure.botConfigured(takoEnv({ TAKO_WEBHOOK_AUTH_HEADER: "X-Evil\r\nX-Injected" }), "tako"),
    false
  );
  assert.equal(
    pure.botConfigured(takoEnv({ TAKO_WEBHOOK_KEY: "line1\nline2" }), "tako"),
    false
  );
  // Croissand's configured check does not grow a webhook requirement.
  assert.equal(
    pure.botConfigured(
      { DISCORD_BOT_TOKEN: "t", CLAUDE_HOOK_SECRET: "s", ...takoEnv() },
      "croissand"
    ),
    true
  );
});

// ---------- inbound filter ----------

test("filter: the owner's guild name-call of tako is forwarded, including display-name and latin forms", () => {
  const calls = [
    "たこ、これ見て",
    "たこ",
    "たこさん、おはよう",
    "たこ教えて",
    "たこ · 秘書、予定は？",
    "たこ・秘書",
    "たこ•秘書",
    "ｔａｋｏ よろしく",
    "hey tako!",
    "TAKO",
    "Tako, hello",
  ];
  for (const content of calls) {
    const m = message({ content });
    assert.equal(
      pure.shouldForwardMessage(m, TAKO_ID, { names: TAKO_NAMES }),
      true,
      content
    );
    const req = pure.buildForwardRequest(m, TAKO_ID, { names: TAKO_NAMES });
    assert.ok(req, content);
    assert.equal(req.topic, "discord");
    assert.equal(req.request_id, `discord-${m.id}`);
    assert.equal(
      req.text,
      `[discord channel:${m.channel_id} guild:${m.guild_id} author:g_kari]\n${content}`
    );
  }
});

test("filter: food words and other bots' names are not tako name-calls", () => {
  for (const content of ["たこ焼き食べよ", "takoyaki night", "stako", "tako2", "一姫、こんにちは", "クロワッサンド見て", "Hermesの状態は？"]) {
    const m = message({ content });
    assert.equal(
      pure.shouldForwardMessage(m, TAKO_ID, { names: TAKO_NAMES }),
      false,
      content
    );
    assert.equal(pure.buildForwardRequest(m, TAKO_ID, { names: TAKO_NAMES }), null, content);
    assert.equal(pure.shouldForwardMessage(m, CROISSAND_ID), false, content);
    assert.equal(pure.shouldForwardMessage(m, ICHIHIME_ID), false, content);
  }
});

test("filter: tako follows the other bots' mention and DM rules, and name-calls do not widen them", () => {
  const named = message({ content: "たこ、見て" });
  assert.equal(
    pure.shouldForwardMessage(
      message({
        content: `<@${TAKO_ID}> hello`,
        mentions: [{ id: TAKO_ID }],
      }),
      TAKO_ID,
      { names: TAKO_NAMES }
    ),
    true
  );
  // Empty mention metadata still falls back to the token, as croissand does.
  assert.equal(
    pure.shouldForwardMessage(
      message({ content: `<@${TAKO_ID}> hello`, mentions: [] }),
      TAKO_ID,
      { names: TAKO_NAMES }
    ),
    true
  );
  const mentioned = message({
    content: `<@${TAKO_ID}> たこ、見て`,
    mentions: [{ id: TAKO_ID }],
  });
  const req = pure.buildForwardRequest(mentioned, TAKO_ID, { names: TAKO_NAMES });
  assert.equal(
    req.text,
    `[discord channel:${mentioned.channel_id} guild:${mentioned.guild_id} author:g_kari]\nたこ、見て`
  );
  assert.equal(pure.buildForwardRequest(message({ content: `<@${TAKO_ID}>`, mentions: [{ id: TAKO_ID }] }), TAKO_ID, { names: TAKO_NAMES }), null);

  const dm = message({ guild_id: undefined, content: "予定だけ教えて" });
  assert.equal(pure.shouldForwardMessage(dm, TAKO_ID, { names: TAKO_NAMES }), true);
  assert.ok(pure.buildForwardRequest(dm, TAKO_ID, { names: TAKO_NAMES }));

  for (const author of [
    { id: CROISSAND_ID, bot: true },
    { id: "123456789012345678", bot: false },
  ]) {
    assert.equal(
      pure.shouldForwardMessage(message({ author, content: "たこ、見て" }), TAKO_ID, { names: TAKO_NAMES }),
      false
    );
  }
  assert.equal(
    pure.shouldForwardMessage(
      message({
        author: { id: CROISSAND_ID, bot: true },
        content: `<@${TAKO_ID}> handoff`,
        mentions: [{ id: TAKO_ID }],
      }),
      TAKO_ID,
      { names: TAKO_NAMES }
    ),
    true
  );
  assert.equal(
    pure.shouldForwardMessage(message({ webhook_id: "999", content: "たこ" }), TAKO_ID, { names: TAKO_NAMES }),
    false
  );
  assert.equal(
    pure.shouldForwardMessage(
      message({ author: { id: TAKO_ID, bot: true }, content: "たこ、了解" }),
      TAKO_ID,
      { names: TAKO_NAMES }
    ),
    false
  );
  // A name-call does not become a forward for the other hosted bots.
  assert.equal(pure.shouldForwardMessage(named, CROISSAND_ID), false);
  assert.equal(pure.shouldForwardMessage(named, ICHIHIME_ID), false);
  // Naming tako beside someone else's mention still reaches tako only.
  const beside = message({
    content: `<@${CROISSAND_ID}> たこ、これも見て`,
    mentions: [{ id: CROISSAND_ID }],
  });
  assert.equal(pure.shouldForwardMessage(beside, TAKO_ID, { names: TAKO_NAMES }), true);
  assert.equal(pure.shouldForwardMessage(beside, CROISSAND_ID), true);
  assert.equal(pure.shouldForwardMessage(beside, ICHIHIME_ID), false);
  for (const fields of [
    { content: "@everyone hi", mention_everyone: true },
    { content: "<@&123456789012345678> hi", mention_roles: ["123456789012345678"] },
  ]) {
    assert.equal(
      pure.shouldForwardMessage(message(fields), TAKO_ID, { names: TAKO_NAMES }),
      false
    );
  }
  assert.equal(
    pure.shouldForwardMessage(
      message({ content: "@everyone たこ、聞いて", mention_everyone: true }),
      TAKO_ID,
      { names: TAKO_NAMES }
    ),
    true
  );
});

test("protocol: only tako's socket turns a name-call into a forward; ambient keeps the channel otherwise", () => {
  const named = message({
    channel_id: "477496219040743435",
    content: "たこ、これ見て",
  });
  const payload = { op: 0, s: 4, t: "MESSAGE_CREATE", d: named };
  const tako = pure.handleGatewayPayload(
    { ...DS, botUserId: TAKO_ID },
    payload,
    { now: 1762470000000, botKey: "tako" }
  );
  const forwards = tako.actions.filter((a) => a.type === "forward");
  assert.equal(forwards.length, 1);
  assert.equal(forwards[0].request.request_id, `discord-${named.id}`);
  assert.equal(forwards[0].request.topic, "discord");
  assert.match(forwards[0].request.text, /^\[discord channel:/);

  for (const botKey of ["croissand", "ichihime"]) {
    const other = pure.handleGatewayPayload(
      { ...DS, botUserId: botKey === "croissand" ? CROISSAND_ID : ICHIHIME_ID },
      payload,
      { now: 1762470000000, botKey }
    );
    assert.equal(other.actions.filter((a) => a.type === "forward").length, 0, botKey);
  }
  assert.equal(pure.buildAmbientRequest(named), null);
  const bystander = message({
    channel_id: "477496219040743435",
    author: { id: "444555666777888999", username: "alice", bot: false },
    content: "たこ、見て",
  });
  assert.equal(pure.shouldForwardMessage(bystander, TAKO_ID, { names: TAKO_NAMES }), false);
  assert.ok(pure.buildAmbientRequest(bystander));
  const food = message({
    channel_id: "477496219040743435",
    content: "takoyaki night",
  });
  const ambient = pure.buildAmbientRequest(food);
  assert.ok(ambient);
  assert.equal(ambient.topic, "hermes-ambient");
  assert.equal(ambient.request_id, `ambient-${food.id}`);
});

// ---------- webhook delivery ----------

test("attemptForward: tako posts the body to the configured webhook with Bearer auth by default", async () => {
  const env = {
    ...takoEnv(),
    FORWARD_MODE: "trigger",
    EVENTS_TRIGGER_KEY: "should-not-be-used",
    CLAUDE_HOOK_SECRET: "should-not-be-used",
  };
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env,
    bot: "tako",
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
  assert.equal(calls[0].url, WEBHOOK_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.body, BODY);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${WEBHOOK_KEY}`);
  assert.equal(calls[0].init.headers["webhook-signature"], undefined);
  assert.equal(calls[0].init.headers["webhook-id"], undefined);
  assert.ok(calls[0].init.signal);
});

test("attemptForward: TAKO_WEBHOOK_AUTH_HEADER renames the credential header and sends the raw key", async () => {
  const { impl, calls } = fakeFetch(okJson());
  const result = await pure.attemptForward({
    env: takoEnv({ TAKO_WEBHOOK_AUTH_HEADER: "X-Webhook-Key" }),
    bot: "tako",
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(result.delivered, true);
  assert.equal(calls[0].init.headers["X-Webhook-Key"], WEBHOOK_KEY);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("attemptForward: webhook classifies status like trigger mode and never echoes secrets", async () => {
  const secretUrl = "https://grok-bot.example/hooks/tako?token=query-secret";
  const env = takoEnv({ TAKO_WEBHOOK_URL: secretUrl });
  for (const status of [400, 401, 403, 404, 422]) {
    const { impl } = fakeFetch(new Response("no", { status }));
    const result = await pure.attemptForward({
      env,
      bot: "tako",
      fetchImpl: impl,
      requestId: "discord-42",
      body: BODY,
    });
    assert.equal(result.delivered, false, `status ${status}`);
    assert.equal(result.final, true, `status ${status}`);
    assert.equal(result.error, `webhook HTTP ${status} for discord-42`);
    assert.equal(result.error.includes(WEBHOOK_KEY), false);
    assert.equal(result.error.includes("query-secret"), false);
  }
  for (const status of [500, 502, 503]) {
    const { impl } = fakeFetch(new Response("no", { status }));
    const result = await pure.attemptForward({
      env,
      bot: "tako",
      fetchImpl: impl,
      requestId: "discord-42",
      body: BODY,
    });
    assert.equal(result.final, false, `status ${status}`);
    assert.equal(result.delivered, false, `status ${status}`);
  }
  const retry = fakeFetch(new Response("slow", { status: 429, headers: { "Retry-After": "2" } }));
  const fromHeader = await pure.attemptForward({
    env,
    bot: "tako",
    fetchImpl: retry.impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(fromHeader.final, false);
  assert.equal(fromHeader.retryAfterMs, 2000);
  const fromBody = fakeFetch(new Response(JSON.stringify({ retry_after: 3 }), { status: 429 }));
  const delayed = await pure.attemptForward({
    env,
    bot: "tako",
    fetchImpl: fromBody.impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(delayed.final, false);
  assert.equal(delayed.retryAfterMs, 3000);
  const down = fakeFetch(new Error("network down"));
  const failed = await pure.attemptForward({
    env,
    bot: "tako",
    fetchImpl: down.impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.deepEqual(failed, {
    delivered: false,
    final: false,
    error: "webhook request failed for discord-42",
    retryAfterMs: null,
  });
  assert.equal(failed.error.includes(WEBHOOK_KEY), false);
});

test("attemptForward: croissand and ichihime ignore tako's webhook settings", async () => {
  const env = {
    ...takoEnv(),
    CLAUDE_HOOK_SECRET: "whsec_" + Buffer.alloc(32).toString("base64"),
    EVENTS_TRIGGER_KEY: "trigger-key",
    FORWARD_MODE: "claude-hook",
  };
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return okJson();
  };
  await pure.attemptForward({
    env,
    bot: "croissand",
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  await pure.attemptForward({
    env,
    bot: "ichihime",
    fetchImpl: impl,
    requestId: "discord-42",
    body: BODY,
  });
  assert.equal(calls[0].url, "https://dots-events.0g0.xyz/claude-hook");
  assert.ok(calls[0].init.headers["webhook-signature"]);
  assert.equal(calls[1].url, "https://dots-events.0g0.xyz/trigger");
  assert.equal(calls[1].init.headers.Authorization, "Bearer trigger-key");
});

function fakeKv() {
  const map = new Map();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT key, value FROM kv")) {
      const v = map.get(params[0]);
      return { toArray: () => (v === undefined ? [] : [{ key: params[0], value: v }]) };
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

function makeGateway(env, exec) {
  const gateway = Object.create(pure.Gateway.prototype);
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
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    waitUntil: (p) => {
      flushes.push(p);
    },
  };
  return { gateway, flushes };
}

test("unconfigured tako: quiet under connect and alarm while croissand still runs", async () => {
  const kv = fakeKv();
  const exec = (sql, ...params) => {
    if (sql.startsWith("SELECT bot, request_id, body, attempts FROM outbox")) {
      return { toArray: () => [] };
    }
    return kv.exec(sql, ...params);
  };
  const { gateway, flushes } = makeGateway(
    { DISCORD_BOT_TOKEN: "croissand-token", CLAUDE_HOOK_SECRET: "whsec_abc" },
    exec
  );
  const snap = await gateway.connectLocked("tako", { manual: true });
  assert.deepEqual(snap, { connected: false, ready: false, configured: false });
  assert.equal(gateway.loadState("tako").lastError, null);
  assert.equal(gateway._sockets.tako ?? null, null);
  const calls = [];
  const down = async (url) => {
    calls.push(url);
    throw new Error("network down");
  };
  const original = globalThis.fetch;
  globalThis.fetch = down;
  try {
    await gateway.alarm();
    await Promise.all(flushes);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(typeof gateway.loadState("croissand").nextReconnectAt, "number");
  assert.equal(gateway.loadState("tako").nextReconnectAt, null);
  assert.equal(calls.some((url) => String(url).includes("tako")), false);
});

// ---------- HTTP ----------

function makeOutboundRecorder() {
  const sends = [];
  let avatarAuth = null;
  const service = async (req) => {
    if (req.url === "https://discord.com/api/v10/users/@me" && req.method === "PATCH") {
      avatarAuth = req.headers.get("Authorization");
      return Response.json({ id: TAKO_ID, username: "tako", avatar: "hash-tako" }, { status: 200 });
    }
    if (req.url.startsWith("https://discord.com/api/v10/channels/")) {
      const body = await req.json();
      sends.push({ url: req.url, authorization: req.headers.get("Authorization"), body });
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
  const res = await mf.dispatchFetch(ORIGIN + path, {
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
  return { status: res.status, json, text };
}

let mfIdle;
let mfTako;
let recTako;
before(async () => {
  mfIdle = await makeWorker(
    { DISCORD_BOT_TOKEN: "croissand-token", CLAUDE_HOOK_SECRET: "whsec_abc", ADMIN_KEY },
    makeOutboundRecorder().service
  );
  recTako = makeOutboundRecorder();
  mfTako = await makeWorker(
    { ...takoEnv(), ADMIN_KEY },
    recTako.service
  );
});
after(async () => {
  await mfIdle?.dispose();
  await mfTako?.dispose();
});

test("http: /status reports bots.tako without secrets, idle until configured", async () => {
  const idle = await (await mfIdle.dispatchFetch(ORIGIN + "/status")).json();
  assert.deepEqual(idle.bots.tako, { connected: false, ready: false, configured: false });
  assert.equal(JSON.stringify(idle).includes(TAKO_TOKEN), false);
  assert.equal(JSON.stringify(idle).includes(WEBHOOK_KEY), false);
  const live = await (await mfTako.dispatchFetch(ORIGIN + "/status")).json();
  assert.deepEqual(live.bots.tako, { connected: false, ready: false, configured: true });
  assert.equal(JSON.stringify(live).includes(TAKO_TOKEN), false);
  assert.equal(JSON.stringify(live).includes(WEBHOOK_KEY), false);
  assert.equal(JSON.stringify(live).includes(WEBHOOK_URL), false);
});

test("http: /send and /avatar accept bot tako and reject it when the token is unset", async () => {
  const missing = await post(mfIdle, "/send", {
    channel_id: "222333444555666777",
    content: "from tako",
    bot: "tako",
  });
  assert.equal(missing.status, 500);
  assert.equal(missing.json.error, "discord bot not configured");
  const sent = await post(mfTako, "/send", {
    channel_id: "222333444555666777",
    content: "from tako",
    bot: "tako",
  });
  assert.equal(sent.status, 201);
  assert.equal(recTako.sends.at(-1).authorization, `Bot ${TAKO_TOKEN}`);
  assert.equal(recTako.sends.at(-1).body.content, "from tako");
  const avatar = await post(mfTako, "/avatar", { image_base64: PNG_1PX_B64, bot: "tako" });
  assert.equal(avatar.status, 200);
  assert.equal(recTako.getAvatarAuth(), `Bot ${TAKO_TOKEN}`);
  const connect = await post(mfIdle, "/connect", { bot: "tako" });
  assert.equal(connect.status, 200);
  assert.equal(connect.json.bots.tako.connected, false);
  assert.equal(connect.json.bots.tako.ready, false);
  assert.equal(connect.json.bots.tako.lastError, null);
  const after = await (await mfIdle.dispatchFetch(ORIGIN + "/status")).json();
  assert.deepEqual(after.bots.tako, { connected: false, ready: false, configured: false });
});

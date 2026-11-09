// discord-gateway — a shared Discord ear/mouth for the user's agent mesh.
//
// A single Durable Object (class Gateway, SQLite-backed, one global
// instance) keeps persistent outbound WebSocket connections to the
// Discord Gateway — ONE PER CONFIGURED BOT. Two bots share the Worker
// and the object (the owner's cost decision: one resident object
// instead of two deployments):
//   "croissand" (primary): Muse's bot. Forwards go to dots-events'
//     /claude-hook (signed), filed as requests for Muse.
//   "ichihime": dots' bot. Forwards go to dots-events' /trigger
//     (Bearer key), filed as requests for the hub's subscribers.
// A bot whose secrets are not set is simply idle: it never connects
// and never errors, while the other bot runs exactly as before.
// Outgoing sockets cannot hibernate, so a connected object incurs
// duration charges. SQLite state survives restarts and alarms
// reconnect/resume each connection independently.
//
// Inbound: MESSAGE_CREATE events are filtered by sender and the
// receiving bot's mention rule (see shouldForwardMessage below).
// Eligible DMs and guild messages are forwarded to dots-events.
// The body is
//   {"text": ..., "topic": "discord", "request_id": "discord-<message id>"}
// and the receiver deduplicates by request_id, so redelivery (Discord
// replays dispatches after a resume) is safe. Failed forwards are kept
// in a small SQLite outbox (one row per bot + request_id) and retried
// from the alarm; each row is delivered in its own bot's forward mode
// (see attemptForward):
//   croissand → POST https://dots-events.0g0.xyz/claude-hook, signed
//     with Standard Webhooks (HMAC-SHA256, whsec_ secret — the same
//     scheme dots-kick-events implements for its own /claude-hook
//     intake, so signatures are byte-for-byte compatible).
//   ichihime → POST https://dots-events.0g0.xyz/trigger with
//     Authorization: Bearer <EVENTS_TRIGGER_KEY>, no signing (the
//     /claude-hook intake and its secret belong to Muse's side only).
//
// Outbound: agents reply into Discord through POST /send on this Worker
// (admin-key auth), which calls the Discord REST API with the selected
// bot's token.
//
// Bindings / secrets (names only; values are never committed):
//   GATEWAY                  — Durable Object namespace (class Gateway)
//   DISCORD_BOT_TOKEN        — secret; croissand's Discord bot token
//   DISCORD_BOT_TOKEN_ICHICHIME — secret; ichihime's Discord bot token
//   CLAUDE_HOOK_SECRET       — secret; whsec_ HMAC secret for
//                              croissand's /claude-hook forwards
//   EVENTS_TRIGGER_KEY       — secret; Bearer key for ichihime's
//                              /trigger forwards
//   ADMIN_KEY                — secret; key for POST /connect, /send,
//                              /avatar
//   FORWARD_MODE             — legacy var, only consulted by
//                              attemptForward when no bot is given
//                              (deployments no longer set it)
//
// HTTP routes:
//   GET  /         service info (name / version)
//   GET  /status   public; {"connected": bool, "ready": bool} for the
//                  primary bot (legacy shape) plus "bots" detail:
//                  {"bots": {"croissand": {"connected", "ready",
//                  "configured"}, "ichihime": {...}}}
//   POST /connect  admin key; nudge the Durable Object to (re)connect;
//                  optional JSON body {"bot": "ichihime"} targets one
//                  bot (absent = all bots). The response carries
//                  admin-only diagnostics for the primary bot
//                  {connected, ready, lastError, hasSession,
//                  lastDispatchAt} plus a per-bot "bots" map
//   POST /send     admin key; {"channel_id", "content", "bot"?} ->
//                  Discord REST, sent as the selected bot
//                  ("croissand" by default)
//   POST /avatar   admin key; {"image_base64" | "image_url", "bot"?} ->
//                  PATCH the selected bot's avatar via Discord REST

import { DurableObject } from "cloudflare:workers";

const SERVICE_NAME = "discord-gateway";
const SERVICE_VERSION = "0.5.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";
const CLAUDE_HOOK_URL = "https://dots-events.0g0.xyz/claude-hook";
const EVENTS_TRIGGER_URL = "https://dots-events.0g0.xyz/trigger";
const MAX_FORWARD_ATTEMPTS = 5;

// Gateway intents: GUILDS (1<<0) | DIRECT_MESSAGES (1<<12) |
// GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15) = 37377.
// MESSAGE_CONTENT is a privileged intent and must also be enabled for
// the bot in the Discord Developer Portal. (Not exported: the Workers
// runtime rejects non-function named exports in the main module. Tests
// reach this and DEFAULT_GATEWAY_STATE through __testHooks() below.)
const GATEWAY_INTENTS = 37377;

// ---------- bot registry ----------
// The bots hosted by this deployment, keyed by short name. Each bot
// has its own token secret, its own forward mode + credential, and its
// own gateway connection inside the one Durable Object. userId is the
// bot's Discord user id (informational: the live identity is learned
// from each connection's READY dispatch and kept in that bot's state).
// "croissand" is the primary bot: the legacy single-bot surfaces
// (GET /status top-level fields, POST /connect diagnostics, the /send
// and /avatar defaults) all describe it.

const BOT_CONFIGS = Object.freeze({
  croissand: Object.freeze({
    key: "croissand",
    tokenEnv: "DISCORD_BOT_TOKEN",
    forwardMode: "claude-hook",
    forwardSecretEnv: "CLAUDE_HOOK_SECRET",
    userId: "1568508479293890673",
  }),
  ichihime: Object.freeze({
    key: "ichihime",
    tokenEnv: "DISCORD_BOT_TOKEN_ICHICHIME",
    forwardMode: "trigger",
    forwardSecretEnv: "EVENTS_TRIGGER_KEY",
    userId: "1568548424519913482",
  }),
});
const BOT_KEYS = Object.freeze(Object.keys(BOT_CONFIGS));
const PRIMARY_BOT = "croissand";

function knownBot(botKey) {
  return typeof botKey === "string" && Object.hasOwn(BOT_CONFIGS, botKey);
}

// A bot is configured when both its token and its forward credential
// are present in env. Unconfigured bots stay idle (no connection
// attempts, no errors) while configured bots run normally.
export function botConfigured(env, botKey) {
  const config = knownBot(botKey) ? BOT_CONFIGS[botKey] : null;
  if (!config || !env) return false;
  return Boolean(env[config.tokenEnv] && env[config.forwardSecretEnv]);
}

// ---------- small helpers ----------

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// Constant-time string comparison (for the admin key), same helper as
// dots-kick-events uses.
function timingSafeEqualStr(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] || 0) ^ (eb[i] || 0);
  }
  return diff === 0;
}

// Admin-key check for /connect and /send, same convention as the
// dots-events /trigger endpoint: `Authorization: Bearer <key>` or the
// `X-Trigger-Key` header. A missing ADMIN_KEY rejects everyone.
function isAdminKey(env, request) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const headerKey = request.headers.get("X-Trigger-Key") || "";
  return timingSafeEqualStr(bearer, key) || timingSafeEqualStr(headerKey, key);
}

function b64encode(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(String(str).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- Standard Webhooks signing ----------
// Identical construction to dots-kick-events' hmacKey/signBody/verifyBody:
// the whsec_ secret is base64-decoded after stripping the prefix, and the
// signed content is "<msgId>.<timestampSec>.<body>" with HMAC-SHA256,
// rendered as "v1,<base64>".

async function hmacKey(secret) {
  const raw = b64decode(String(secret).replace(/^whsec_/, ""));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signBody(secret, msgId, timestampSec, body) {
  const key = await hmacKey(secret);
  const signed = new TextEncoder().encode(`${msgId}.${timestampSec}.${body}`);
  const sig = await crypto.subtle.sign("HMAC", key, signed);
  return "v1," + b64encode(new Uint8Array(sig));
}

export async function verifyBody(secret, msgId, timestampSec, body, signatureHeader) {
  try {
    const key = await hmacKey(secret);
    const signed = new TextEncoder().encode(`${msgId}.${timestampSec}.${body}`);
    for (const part of String(signatureHeader || "").split(" ")) {
      const [version, b64] = part.split(",");
      if (version !== "v1" || !b64) continue;
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        b64decode(b64),
        signed
      );
      if (ok) return true;
    }
  } catch (_) {
    /* fall through */
  }
  return false;
}

// ---------- inbound message filtering / forwarding shape ----------

// The owner's Discord user id. Owner guild messages are forwarded
// only when they mention the receiving bot (owner's instruction,
// 2026-11-09: a mention is required). Owner DMs keep their existing
// routing: a DM reaches the bot it was sent to.
const OWNER_USER_ID = "333933401314951168";

// Bot authors are forwarded only when they mention the receiving
// bot, so the bots in the owner's servers can hand messages to each
// other and react to one another (owner's instruction, 2026-11-09).
// Bot messages without a mention of the receiving bot are ignored.

function mentionsBot(message, botUserId) {
  if (!botUserId) return false;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  if (mentions.length > 0) return mentions.some((m) => m && m.id === botUserId);
  return new RegExp(`<@!?${botUserId}>`).test(message.content);
}


// Whether a MESSAGE_CREATE message should be forwarded.
// Ignored: our own messages, webhooks, bot messages that do not
// mention the receiving bot, guild messages from other members,
// and owner guild messages that do not mention the receiving bot.
// Forwarded: owner guild messages mentioning the receiving bot;
// any bot mentioning the receiving bot; DMs from the owner and
// from other humans.
export function shouldForwardMessage(message, botUserId) {
  if (!message || typeof message !== "object") return false;
  if (typeof message.content !== "string") return false;
  const author = message.author;
  if (!author || typeof author.id !== "string") return false;
  if (message.webhook_id) return false;
  if (botUserId && author.id === botUserId) return false; // our own messages
  if (author.id === OWNER_USER_ID) {
    // The owner: guild messages forward only on a mention of the
    // receiving bot. DMs always pass: a DM reaches the bot it was
    // sent to.
    if (message.guild_id) return mentionsBot(message, botUserId);
    return true;
  }
  if (author.bot) {
    return mentionsBot(message, botUserId);
  }
  const isDm = !message.guild_id || message.channel_type === 1 || message.channel_type === 3;
  if (isDm) return true;
  return false;
}

// Build the /claude-hook request body for a forwardable message, or null
// when there is nothing to forward (e.g. the message was only a mention).
// The first line identifies where the message came from so Muse can
// reply to the right channel via POST /send.
export function buildForwardRequest(message, botUserId) {
  if (!shouldForwardMessage(message, botUserId)) return null;
  if (typeof message.id !== "string" || !message.id) return null;
  if (typeof message.channel_id !== "string" || !message.channel_id) return null;
  let content = message.content;
  if (botUserId) {
    content = content
      .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
      .trim();
  } else {
    content = content.trim();
  }
  if (!content) return null;
  const guild =
    typeof message.guild_id === "string" && message.guild_id
      ? message.guild_id
      : "-";
  const username =
    typeof message.author?.username === "string" && message.author.username
      ? message.author.username
      : "unknown";
  const text =
    `[discord channel:${message.channel_id} guild:${guild} author:${username}]\n` +
    content;
  return { text, topic: "discord", request_id: `discord-${message.id}` };
}

// ---------- forward delivery modes ----------
// A forward goes in one of two modes:
//   "claude-hook": signed Standard Webhooks POST to dots-events'
//     /claude-hook — files a request for Muse. Needs
//     CLAUDE_HOOK_SECRET.
//   "trigger": unsigned POST to dots-events' /trigger with
//     Authorization: Bearer <EVENTS_TRIGGER_KEY> — files a request for
//     the hub's subscribers (dots). This mode exists so dots' side
//     never holds Muse's /claude-hook secret.
// Production delivery always names a bot, and the bot's static config
// (BOT_CONFIGS) fixes its mode + credential: croissand → claude-hook,
// ichihime → trigger. The FORWARD_MODE env var is a legacy fallback
// consulted only when no bot is given (attemptForward's original
// single-deployment contract, kept for its tests): anything other
// than the exact string "trigger" selects claude-hook.

export function forwardMode(env) {
  return env && env.FORWARD_MODE === "trigger" ? "trigger" : "claude-hook";
}

// Name of the env var holding the active mode's forward credential.
export function forwardSecretName(env) {
  return forwardMode(env) === "trigger"
    ? "EVENTS_TRIGGER_KEY"
    : "CLAUDE_HOOK_SECRET";
}

// The active mode's forward credential, or undefined when not set.
export function forwardSecret(env) {
  if (!env) return undefined;
  return forwardMode(env) === "trigger"
    ? env.EVENTS_TRIGGER_KEY
    : env.CLAUDE_HOOK_SECRET;
}

// Resolve the effective { mode, secret } for one delivery: the bot's
// static config when a bot is named, the legacy env fallback otherwise.
function forwardTarget(env, bot) {
  const config = knownBot(bot) ? BOT_CONFIGS[bot] : null;
  if (config) {
    return {
      mode: config.forwardMode,
      secret: env ? env[config.forwardSecretEnv] : undefined,
    };
  }
  return { mode: forwardMode(env), secret: forwardSecret(env) };
}

// One forward delivery attempt for an outbox row. Pure apart from the
// injected fetch implementation, so the mode dispatch and the retry
// classification are unit-testable without a Durable Object. `bot`
// names the bot the row belongs to (its static config picks the mode
// and credential); omit it for the legacy env-driven dispatch.
// Returns:
//   { delivered, final, error, retryAfterMs }
// - delivered: the receiver accepted the request (HTTP 2xx).
// - final: retrying the identical body can never succeed, so the
//   caller drops the row now instead of at the attempt cap. Only
//   trigger mode produces this (a non-429 4xx rejects the request
//   itself); claude-hook mode retries every failure to the cap,
//   exactly as before.
// - retryAfterMs: the receiver's 429 delay hint, when one was given.
export async function attemptForward({ env, bot, fetchImpl, requestId, body }) {
  const { mode, secret } = forwardTarget(env, bot);
  if (mode === "trigger") {
    try {
      const res = await fetchImpl(EVENTS_TRIGGER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        await res.body?.cancel();
        return { delivered: true, final: false, error: null, retryAfterMs: null };
      }
      const error = `trigger HTTP ${res.status} for ${requestId}`;
      if (res.status === 429) {
        let bodyJson = null;
        try {
          bodyJson = await res.json();
        } catch (_) {
          /* no JSON body; fall back to the headers */
        }
        const seconds = parseRetryAfterSeconds({
          body: bodyJson,
          headers: res.headers,
        });
        return {
          delivered: false,
          final: false,
          error,
          retryAfterMs: seconds !== null ? Math.ceil(seconds * 1000) : null,
        };
      }
      await res.body?.cancel();
      const final = res.status >= 400 && res.status < 500;
      return { delivered: false, final, error, retryAfterMs: null };
    } catch (_) {
      return {
        delivered: false,
        final: false,
        error: `trigger request failed for ${requestId}`,
        retryAfterMs: null,
      };
    }
  }
  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await signBody(secret, requestId, ts, body);
    const res = await fetchImpl(CLAUDE_HOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": requestId,
        "webhook-timestamp": ts,
        "webhook-signature": signature,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const ok = res.ok;
    let error = null;
    let retryAfterMs = null;
    if (!ok) {
      error = `claude-hook HTTP ${res.status} for ${requestId}`;
      if (res.status === 429) {
        const seconds = parseRetryAfterSeconds({ headers: res.headers });
        if (seconds !== null) retryAfterMs = Math.ceil(seconds * 1000);
      }
    }
    await res.body?.cancel();
    return { delivered: ok, final: false, error, retryAfterMs };
  } catch (_) {
    return {
      delivered: false,
      final: false,
      error: `claude-hook request failed for ${requestId}`,
      retryAfterMs: null,
    };
  }
}

// ---------- gateway protocol state machine (pure) ----------
// The Durable Object persists one state object PER BOT. The same pure
// machine drives every bot's connection: handleGatewayPayload() maps
// (state, gateway payload) -> { state, actions } without touching
// storage or sockets, so the protocol decisions are unit-testable.
// Actions: {type:"identify"} {type:"resume"} {type:"heartbeat"}
//          {type:"close_socket", code} {type:"schedule_alarm"}
//          {type:"forward", request}

const DEFAULT_GATEWAY_STATE = Object.freeze({
  version: 1,
  configured: false,
  connected: false,
  ready: false,
  sessionId: null,
  resumeGatewayUrl: null,
  gatewayUrl: null,
  seq: null,
  botUserId: null,
  botUsername: null,
  heartbeatIntervalMs: 45000,
  helloReceived: false,
  awaitingHeartbeatAck: false,
  lastHeartbeatAt: null,
  lastHeartbeatAckAt: null,
  lastReadyAt: null,
  lastMessageAt: null,
  lastDispatchAt: null,
  reconnectAttempts: 0,
  resumeMode: null, // "resume" | "identify" | null
  expectingClose: false,
  reconnectBlocked: false,
  nextReconnectAt: null,
  nextHeartbeatAt: null,
  nextOutboxAt: null,
  nextWatchdogAt: null,
  socketOpenedAt: null,
  lastConnectAttemptAt: null,
  lastAlarmAt: null,
  lastError: null,
  forwardedCount: 0,
  droppedForwardCount: 0,
  lastForwardAt: null,
  lastForwardError: null,
});

const NUMERIC_STATE_KEYS = [
  "heartbeatIntervalMs",
  "seq",
  "lastHeartbeatAt",
  "lastHeartbeatAckAt",
  "lastReadyAt",
  "lastMessageAt",
  "lastDispatchAt",
  "reconnectAttempts",
  "nextReconnectAt",
  "nextHeartbeatAt",
  "nextOutboxAt",
  "nextWatchdogAt",
  "socketOpenedAt",
  "lastConnectAttemptAt",
  "lastAlarmAt",
  "forwardedCount",
  "droppedForwardCount",
  "lastForwardAt",
];
const STRING_STATE_KEYS = [
  "sessionId",
  "resumeGatewayUrl",
  "gatewayUrl",
  "botUserId",
  "botUsername",
  "resumeMode",
  "lastError",
  "lastForwardError",
];
const BOOLEAN_STATE_KEYS = [
  "configured",
  "connected",
  "ready",
  "helloReceived",
  "awaitingHeartbeatAck",
  "expectingClose",
  "reconnectBlocked",
];

export function normalizeGatewayState(input) {
  const state = { ...DEFAULT_GATEWAY_STATE };
  if (!input || typeof input !== "object") return state;
  for (const key of NUMERIC_STATE_KEYS) {
    const v = input[key];
    state[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  if (!(typeof state.heartbeatIntervalMs === "number" && state.heartbeatIntervalMs > 0)) {
    state.heartbeatIntervalMs = DEFAULT_GATEWAY_STATE.heartbeatIntervalMs;
  }
  for (const key of ["reconnectAttempts", "forwardedCount", "droppedForwardCount"]) {
    if (state[key] === null) state[key] = 0;
  }
  for (const key of STRING_STATE_KEYS) {
    const v = input[key];
    state[key] = typeof v === "string" && v ? v : null;
  }
  for (const key of BOOLEAN_STATE_KEYS) {
    state[key] = input[key] === true;
  }
  state.version = 1;
  return state;
}

function cloneState(state) {
  return normalizeGatewayState(JSON.parse(JSON.stringify(state ?? {})));
}

export function handleGatewayPayload(inputState, payload, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const state = cloneState(inputState);
  const actions = [];
  if (!payload || typeof payload !== "object") return { state, actions };

  if (typeof payload.s === "number" && Number.isFinite(payload.s)) {
    state.seq = payload.s;
  }

  switch (payload.op) {
    case 10: {
      // Hello: Discord tells us the heartbeat interval and expects an
      // Identify (op 2) — or a Resume (op 6) when we hold a session.
      const interval = payload.d?.heartbeat_interval;
      if (typeof interval === "number" && interval > 0) {
        state.heartbeatIntervalMs = interval;
      }
      state.helloReceived = true;
      state.awaitingHeartbeatAck = false;
      const jitter = typeof opts.random === "function" ? opts.random() : Math.random();
      state.nextHeartbeatAt = now + state.heartbeatIntervalMs * Math.max(0, Math.min(1, jitter));
      state.nextWatchdogAt = now + 30000; // Identify/Resume must reach READY/RESUMED
      const canResume =
        state.resumeMode === "resume" &&
        typeof state.sessionId === "string" &&
        state.seq !== null;
      actions.push({ type: canResume ? "resume" : "identify" });
      actions.push({ type: "schedule_alarm" });
      break;
    }
    case 11: {
      // Heartbeat ACK.
      state.awaitingHeartbeatAck = false;
      state.lastHeartbeatAckAt = now;
      break;
    }
    case 1: {
      // Discord requests an immediate heartbeat.
      actions.push({ type: "heartbeat" });
      break;
    }
    case 7: {
      // Reconnect: Discord asks us to close and resume on a new socket.
      state.ready = false;
      state.resumeMode = state.sessionId ? "resume" : "identify";
      state.connected = false;
      state.helloReceived = false;
      state.nextHeartbeatAt = null;
      state.nextWatchdogAt = null;
      state.nextReconnectAt = now + 1000;
      actions.push({ type: "close_socket", code: 4000 });
      actions.push({ type: "schedule_alarm" });
      break;
    }
    case 9: {
      // Invalid Session: d === true means the session may be resumed.
      const resumable =
        payload.d === true &&
        typeof state.sessionId === "string" &&
        state.seq !== null;
      state.ready = false;
      state.connected = false;
      state.helloReceived = false;
      state.nextHeartbeatAt = null;
      state.nextWatchdogAt = null;
      state.resumeMode = resumable ? "resume" : "identify";
      state.nextReconnectAt = now + (resumable ? 1000 : 3000);
      if (!resumable) {
        state.sessionId = null;
        state.resumeGatewayUrl = null;
        state.seq = null;
      }
      state.lastError = "gateway invalid session";
      actions.push({ type: "close_socket", code: 4000 });
      actions.push({ type: "schedule_alarm" });
      break;
    }
    case 0: {
      const d = payload.d || {};
      // Any dispatch frame proves the socket is receiving (Hermes
      // watches the same signal: a socket can keep ACKing heartbeats
      // while going deaf to dispatches).
      state.lastDispatchAt = now;
      if (payload.t === "READY") {
        if (typeof d.session_id === "string") state.sessionId = d.session_id;
        if (typeof d.resume_gateway_url === "string") {
          state.resumeGatewayUrl = d.resume_gateway_url;
        }
        if (typeof d.user?.id === "string") state.botUserId = d.user.id;
        if (typeof d.user?.username === "string") {
          state.botUsername = d.user.username;
        }
        state.ready = true;
        state.connected = true;
        state.reconnectAttempts = 0;
        state.resumeMode = "resume";
        state.nextWatchdogAt = null;
        state.lastReadyAt = now;
        state.lastError = null;
      } else if (payload.t === "RESUMED") {
        state.ready = true;
        state.connected = true;
        state.reconnectAttempts = 0;
        state.resumeMode = "resume";
        state.nextWatchdogAt = null;
        state.lastReadyAt = now;
        state.lastError = null;
      } else if (payload.t === "MESSAGE_CREATE") {
        state.lastMessageAt = now;
        const request = buildForwardRequest(d, state.botUserId);
        if (request) actions.push({ type: "forward", request });
      }
      break;
    }
    default:
      break;
  }
  return { state, actions };
}

// Decide what the alarm should do when a heartbeat comes due. A missed
// ACK means the connection is a zombie: Discord's own guidance is to
// close it and reconnect (the caller performs the close/resume).
export function heartbeatDecision(inputState, now = Date.now()) {
  const state = cloneState(inputState);
  if (!state.helloReceived || !(state.heartbeatIntervalMs > 0)) {
    return { state, action: "none" };
  }
  if (state.awaitingHeartbeatAck) {
    const next = {
      ...state,
      awaitingHeartbeatAck: false,
      ready: false,
    };
    return { state: next, action: "reconnect", reason: "heartbeat_ack_timeout" };
  }
  const next = {
    ...state,
    awaitingHeartbeatAck: true,
    lastHeartbeatAt: now,
    nextHeartbeatAt: now + state.heartbeatIntervalMs,
  };
  return {
    state: next,
    action: "send_heartbeat",
    payload: { op: 1, d: state.seq },
  };
}

const MAX_EVENT_SILENCE_MS = 4 * 60 * 60 * 1000; // 4h, Hermes' default

// A socket can keep ACKing heartbeats (op 11) while Discord stops
// delivering dispatches — Hermes force-reconnects such an "ACKing but
// deaf" socket by watching the last DISPATCH time. Adapted to the DO:
// the alarm applies this decision; reconnecting resumes the session,
// and replayed events are deduped downstream, so a false positive is
// cheap while a deaf socket would otherwise look healthy forever.
export function eventSilenceDecision(
  inputState,
  now = Date.now(),
  maxSilenceMs = MAX_EVENT_SILENCE_MS
) {
  const state = cloneState(inputState);
  if (!state.ready || !state.lastDispatchAt) return { action: "none" };
  if (now - state.lastDispatchAt <= maxSilenceMs) return { action: "none" };
  return { action: "reconnect", reason: "dispatch_silence" };
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const SESSION_INVALID_CLOSE_CODES = new Set([4007, 4009]);

// Decide reconnect timing / session handling after the socket closes.
export function reconnectDecisionForClose(inputState, code, now = Date.now()) {
  const state = cloneState(inputState);
  const fatal = FATAL_CLOSE_CODES.has(code);
  const sessionInvalid = SESSION_INVALID_CLOSE_CODES.has(code);
  const clearSession = fatal || sessionInvalid;
  state.connected = false;
  state.ready = false;
  state.helloReceived = false;
  state.awaitingHeartbeatAck = false;
  state.expectingClose = false;
  state.nextHeartbeatAt = null;
  state.nextWatchdogAt = null;
  state.reconnectBlocked = fatal;
  if (clearSession) {
    state.sessionId = null;
    state.resumeGatewayUrl = null;
    state.seq = null;
    state.resumeMode = "identify";
    // 4014 (disallowed intents) is the actionable one: Hermes prints
    // the Developer Portal fix for it, and so do we (into lastError,
    // which shows up wherever the DO state is inspected).
    state.lastError =
      code === 4014
        ? "gateway closed 4014: privileged intents rejected — enable the MESSAGE CONTENT intent in the Discord Developer Portal (application > Bot > Privileged Gateway Intents)"
        : `gateway closed with fatal code ${code}`;
  } else {
    state.resumeMode = state.sessionId ? "resume" : "identify";
  }
  state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
  const delayMs = fatal
    ? null
    : sessionInvalid
      ? 1000
      : Math.min(60000, 1000 * 2 ** (state.reconnectAttempts - 1));
  state.nextReconnectAt = fatal ? null : now + delayMs;
  return { state, delayMs, clearSession };
}

function identifyPayload(token) {
  return {
    token,
    intents: GATEWAY_INTENTS,
    properties: {
      os: "cloudflare-workers",
      browser: SERVICE_NAME,
      device: SERVICE_NAME,
    },
    compress: false,
  };
}

function withGatewayParams(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  return url.toString();
}

// Acquire a client socket using the Workers HTTP Upgrade API. Outbound
// sockets cannot be registered with the server-only hibernation API.
export async function openGatewaySocket(fetchImpl, url) {
  const upgradeUrl = String(url).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  const res = await fetchImpl(upgradeUrl, {
    headers: { Upgrade: "websocket" },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  const ws = res?.webSocket;
  if (!ws || res.status !== 101) {
    await res?.body?.cancel();
    throw new Error("gateway upgrade failed: HTTP " + (res ? res.status : "no response"));
  }
  return ws;
}

// Keep the attachment helper shared by runtime callers and tests. Install
// listeners before accept() releases frames queued during the handshake.
export function attachGatewaySocket({ ws, handlers }) {
  ws.addEventListener("message", event => handlers.onMessage(event.data));
  ws.addEventListener("close", event => handlers.onClose(event.code, event.reason, event.wasClean));
  ws.addEventListener("error", event => handlers.onError(event));
  try { ws.accept(); } catch (error) {
    if (ws.readyState !== 1) throw error; // tolerate only an already-open client
  }
  return "inline";
}

// Test-only access to the non-function values above (the Workers runtime
// requires every named export of the main module to be a function or a
// handler class, so constants/objects cannot be exported directly).
export function __testHooks() {
  return { GATEWAY_INTENTS, DEFAULT_GATEWAY_STATE, MAX_EVENT_SILENCE_MS, BOT_CONFIGS, BOT_KEYS, PRIMARY_BOT };
}

// ---------- Durable Object: Gateway ----------

export class Gateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._lock = Promise.resolve();
    // Live gateway sockets, one per bot: botKey -> { ws, mode } | null.
    this._sockets = {};
    this._connectPromises = {};
    this._flushPromises = {};
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS outbox (" +
        "bot TEXT NOT NULL DEFAULT 'croissand', " +
        "request_id TEXT NOT NULL, body TEXT NOT NULL, " +
        "attempts INTEGER NOT NULL DEFAULT 0, " +
        "next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
        "PRIMARY KEY (bot, request_id))"
    );
    // Completed forwards, kept for a week: after a gateway Resume,
    // Discord replays recent events, and Hermes dedups those replays
    // with a local cache for the same reason. The receiver dedups by
    // request_id too, so this table only saves redundant round trips.
    // Keyed per bot: one Discord message can be delivered to BOTH bots
    // (e.g. a message mentioning both), and each bot must forward its
    // own copy to its own target.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS forward_log (" +
        "bot TEXT NOT NULL DEFAULT 'croissand', " +
        "request_id TEXT NOT NULL, completed_at INTEGER NOT NULL, " +
        "PRIMARY KEY (bot, request_id))"
    );
    this.migrateStorage();
    // Self-start: if any bot is configured and no alarm is pending,
    // arrange a watchdog wake-up so a configured-but-disconnected
    // object reconnects on its own (e.g. after a deploy or object
    // restart with no alarm).
    try {
      this.ctx.blockConcurrencyWhile(async () => {
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null && this.anyBotConfigured()) {
          await this.ctx.storage.setAlarm(Date.now() + 60000);
        }
      });
    } catch (_) {
      /* best effort */
    }
  }

  // In-place storage upgrade for the two-bot layout. Tables created
  // by the single-bot versions have no `bot` column and a bare
  // request_id primary key; rebuild them with the bot dimension,
  // attributing every existing row to croissand (the only bot that
  // could have filed it). No Durable Object class changes and no
  // wrangler migrations are involved — the class name stays Gateway.
  // Safe to call repeatedly: it no-ops once the column exists.
  migrateStorage() {
    // Keep both table rebuilds atomic, including a failure between DROP
    // and RENAME. A retry must see the old rows, never an empty new table.
    this.ctx.storage.transactionSync(() => this.migrateBotTables());
  }

  migrateBotTables() {
    this.ensureBotDimension(
      "outbox",
      "(bot TEXT NOT NULL DEFAULT 'croissand', request_id TEXT NOT NULL, " +
        "body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, " +
        "next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
        "PRIMARY KEY (bot, request_id))",
      ["request_id", "body", "attempts", "next_attempt_at", "created_at"]
    );
    this.ensureBotDimension(
      "forward_log",
      "(bot TEXT NOT NULL DEFAULT 'croissand', request_id TEXT NOT NULL, " +
        "completed_at INTEGER NOT NULL, PRIMARY KEY (bot, request_id))",
      ["request_id", "completed_at"]
    );
  }

  ensureBotDimension(table, createBody, columns) {
    const info = this.ctx.storage.sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray();
    if (!info.length || info.some((c) => c.name === "bot")) return;
    const tmp = `${table}_v2`;
    const cols = columns.join(", ");
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${tmp}`);
    this.ctx.storage.sql.exec(`CREATE TABLE ${tmp} ${createBody}`);
    this.ctx.storage.sql.exec(
      `INSERT INTO ${tmp} (bot, ${cols}) SELECT '${PRIMARY_BOT}', ${cols} FROM ${table}`
    );
    this.ctx.storage.sql.exec(`DROP TABLE ${table}`);
    this.ctx.storage.sql.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  }

  // Serialize state mutations inside the object; gateway events, alarms
  // and HTTP nudges must not interleave their read-modify-write cycles.
  async runLocked(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  isConfigured(botKey = PRIMARY_BOT) {
    return botConfigured(this.env, botKey);
  }

  anyBotConfigured() {
    return BOT_KEYS.some((botKey) => this.isConfigured(botKey));
  }

  stateKey(botKey) {
    return `gateway-state:${botKey}`;
  }

  readStateRow(key) {
    const rows = this.ctx.storage.sql
      .exec("SELECT key, value FROM kv WHERE key = ?", key)
      .toArray();
    if (!rows.length) return null;
    try {
      return normalizeGatewayState(JSON.parse(rows[0].value));
    } catch (_) {
      return null;
    }
  }

  // Per-bot state. The single-bot versions stored the one state under
  // the kv key "gateway-state"; on first load for the primary bot,
  // that legacy row is adopted as croissand's state (copied to the
  // per-bot key, legacy key deleted) so the live session — session_id,
  // seq, resume URL — survives the upgrade and can Resume.
  loadState(botKey = PRIMARY_BOT) {
    const own = this.readStateRow(this.stateKey(botKey));
    if (own) return own;
    if (botKey === PRIMARY_BOT) {
      const legacy = this.readStateRow("gateway-state");
      if (legacy) {
        const migrated = this.saveState(legacy, botKey);
        this.ctx.storage.sql.exec(
          "DELETE FROM kv WHERE key = ?",
          "gateway-state"
        );
        return migrated;
      }
    }
    return normalizeGatewayState(null);
  }

  saveState(state, botKey = PRIMARY_BOT) {
    const normalized = normalizeGatewayState(state);
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      this.stateKey(botKey),
      JSON.stringify(normalized)
    );
    return normalized;
  }

  getGatewaySocket(botKey = PRIMARY_BOT) {
    const entry = this._sockets[botKey];
    const ws = entry?.ws;
    return ws && (ws.readyState === 0 || ws.readyState === 1) ? ws : null;
  }

  // Which bot a socket belongs to (used by the runtime webSocket*
  // callbacks, which do not carry bot context).
  botKeyForSocket(ws) {
    for (const botKey of BOT_KEYS) {
      if (this._sockets[botKey]?.ws === ws) return botKey;
    }
    return null;
  }

  closeGatewaySocket(botKey, ws, reason) {
    if (this._sockets[botKey]?.ws === ws) {
      this._sockets[botKey] = null;
    }
    try { ws.close(4000, reason); } catch (_) { /* already closed */ }
  }

  statusSnapshot(botKey = PRIMARY_BOT) {
    const state = this.loadState(botKey);
    const socket = this.getGatewaySocket(botKey);
    const connected = socket?.readyState === 1;
    return {
      connected,
      ready: connected && state.ready,
      configured: this.isConfigured(botKey),
    };
  }

  // Admin-only view: statusSnapshot() plus the recorded failure state,
  // so an operator holding the admin key can see WHY a connect attempt
  // is not landing (missing secrets, gateway lookup failure, close code
  // guidance, ...). Relayed only by the admin-gated POST /connect; the
  // public GET /status keeps the bot detail free of failure internals.
  diagnosticsSnapshot(botKey = PRIMARY_BOT) {
    const state = this.loadState(botKey);
    const { connected, ready } = this.statusSnapshot(botKey);
    return {
      connected,
      ready,
      lastError: state.lastError ?? null,
      hasSession:
        typeof state.sessionId === "string" && state.sessionId !== null,
      lastDispatchAt: state.lastDispatchAt ?? null,
    };
  }

  // Aggregate diagnostics for POST /connect: the primary bot's fields
  // at top level (the legacy shape) plus every bot under "bots".
  diagnosticsResponse() {
    const bots = {};
    for (const botKey of BOT_KEYS) {
      bots[botKey] = this.diagnosticsSnapshot(botKey);
    }
    return { ...bots[PRIMARY_BOT], bots };
  }

  // The next alarm is the earliest deadline across ALL bots: each
  // bot's next heartbeat, reconnect, handshake watchdog, dispatch-
  // silence deadline and outbox retry, plus the periodic self-start
  // watchdog for configured bots. Callers save state before calling;
  // the states are reloaded here so every bot contributes its own.
  async scheduleAlarmLocked() {
    const now = Date.now();
    const candidates = [];
    for (const botKey of BOT_KEYS) {
      if (!this.isConfigured(botKey)) continue;
      const state = this.loadState(botKey);
      const nextOutboxAt = state.nextOutboxAt ?? this.earliestOutboxAt(botKey);
      if (nextOutboxAt && !this._flushPromises?.[botKey]) candidates.push(nextOutboxAt);
      if (!state.reconnectBlocked && state.nextReconnectAt && !this._connectPromises?.[botKey]) candidates.push(state.nextReconnectAt);
      if (state.nextHeartbeatAt) candidates.push(state.nextHeartbeatAt);
      if (state.nextWatchdogAt) candidates.push(state.nextWatchdogAt);
      if (state.ready && state.lastDispatchAt) {
        candidates.push(state.lastDispatchAt + MAX_EVENT_SILENCE_MS);
      }
      if (this.isConfigured(botKey) && !state.reconnectBlocked) candidates.push(now + 60000); // watchdog
    }
    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.max(now + 250, Math.min(...candidates));
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing <= at) return;
    await this.ctx.storage.setAlarm(at);
  }

  // --- internal HTTP (called only by the Worker front-end) ---

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/status" && request.method === "GET") {
      return this.runLocked(async () => {
        const bots = {};
        for (const botKey of BOT_KEYS) {
          bots[botKey] = this.statusSnapshot(botKey);
        }
        const primary = bots[PRIMARY_BOT];
        return jsonResponse({
          connected: primary.connected,
          ready: primary.ready,
          bots,
        });
      });
    }
    if (url.pathname === "/internal/connect" && request.method === "POST") {
      let bot = null;
      try {
        const body = await request.json();
        if (body && knownBot(body.bot)) {
          bot = body.bot;
        }
      } catch (_) {
        /* no body: nudge every bot */
      }
      const pending = await this.runLocked(async () => {
        const targets = bot ? [bot] : BOT_KEYS;
        for (const botKey of targets) {
          await this.connectLocked(botKey, { manual: true });
        }
        return targets.map((botKey) => this._connectPromises?.[botKey]);
      });
      // Only the caller waits for network I/O. Other sockets, alarms and
      // status requests can keep using the shared object's state lock.
      await Promise.all(pending);
      return this.runLocked(() => jsonResponse(this.diagnosticsResponse()));
    }
    return new Response("not found", { status: 404 });
  }

  // --- connection management ---

  async gatewayUrlForConnect(botKey, state) {
    if (
      state.resumeMode === "resume" &&
      state.sessionId &&
      state.resumeGatewayUrl
    ) {
      return withGatewayParams(state.resumeGatewayUrl);
    }
    let base = state.gatewayUrl || DEFAULT_GATEWAY_URL;
    try {
      const res = await fetch(`${DISCORD_API_BASE}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.env[BOT_CONFIGS[botKey].tokenEnv]}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (typeof j?.url === "string" && j.url) {
          state.gatewayUrl = j.url;
          base = j.url;
        }
      } else {
        state.lastError = `discord gateway lookup failed: HTTP ${res.status}`;
      }
    } catch (e) {
      state.lastError = `discord gateway lookup failed: ${String(e).slice(0, 120)}`;
    }
    return withGatewayParams(base);
  }

  // Callers hold the state lock only while reserving the attempt.
  async connectLocked(botKey = PRIMARY_BOT, { manual = false } = {}) {
    const state = this.loadState(botKey);
    if (manual) state.reconnectBlocked = false;
    if (state.reconnectBlocked) return this.statusSnapshot(botKey);
    state.configured = this.isConfigured(botKey);
    if (!state.configured) {
      state.connected = false;
      state.ready = false;
      state.helloReceived = false;
      state.awaitingHeartbeatAck = false;
      state.nextHeartbeatAt = null;
      state.nextReconnectAt = null;
      state.nextWatchdogAt = null;
      state.lastError = null;
      const socket = this._sockets[botKey]?.ws;
      if (socket) this.closeGatewaySocket(botKey, socket, "bot unconfigured");
      this.saveState(state, botKey);
      return this.statusSnapshot(botKey);
    }
    const existing = this.getGatewaySocket(botKey);
    if (existing) {
      state.connected = true;
      this.saveState(state, botKey);
      await this.scheduleAlarmLocked();
      return this.statusSnapshot(botKey);
    }
    this._connectPromises ||= {};
    if (this._connectPromises[botKey]) return this.statusSnapshot(botKey);
    const stale = this._sockets[botKey]?.ws;
    if (stale) this.closeGatewaySocket(botKey, stale, "replaced");
    state.lastConnectAttemptAt = Date.now();
    state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
    state.connected = false;
    state.ready = false;
    state.helloReceived = false;
    state.awaitingHeartbeatAck = false;
    state.nextHeartbeatAt = null;
    state.nextReconnectAt = null;
    state.nextWatchdogAt = null;
    this.saveState(state, botKey);
    // Do not await this inside runLocked: a bot's lookup and Upgrade can
    // each take ten seconds. Coalesce repeated nudges while it is pending.
    const attempt = this.openBotConnection(botKey, state).finally(async () => {
      delete this._connectPromises[botKey];
      await this.runLocked(() => this.scheduleAlarmLocked());
    });
    this._connectPromises[botKey] = attempt;
    this.ctx.waitUntil(attempt);
    await this.scheduleAlarmLocked();
    return this.statusSnapshot(botKey);
  }

  async openBotConnection(botKey, connectingState) {
    let ws;
    let error = null;
    try {
      const url = await this.gatewayUrlForConnect(botKey, connectingState);
      ws = await openGatewaySocket(fetch, url);
    } catch (e) {
      error = `gateway connect failed: ${String(e).slice(0, 120)}`;
    }
    await this.runLocked(async () => {
      // Outbox delivery and other activity may have saved newer counters
      // during I/O. Merge connection fields into the current state only.
      const state = this.loadState(botKey);
      state.gatewayUrl = connectingState.gatewayUrl;
      if (error) {
        state.connected = false;
        state.ready = false;
        state.lastError = error;
        const delay = Math.min(60000, 1000 * 2 ** Math.min(6, state.reconnectAttempts - 1));
        state.nextReconnectAt = Date.now() + delay;
        this.saveState(state, botKey);
        return;
      }
      if (!this.isConfigured(botKey)) {
        try { ws.close(4000, "bot unconfigured"); } catch (_) { /* already closed */ }
        return;
      }
      // Install ownership before accept() can release queued frames.
      this._sockets[botKey] = { ws, mode: "inline" };
      try {
        const mode = attachGatewaySocket({
          ctx: this.ctx,
          ws,
          handlers: {
            onMessage: (data) => this.ctx.waitUntil(this.handleSocketMessage(botKey, ws, data)),
            onClose: (code, reason, wasClean) =>
              this.ctx.waitUntil(this.handleSocketClose(botKey, ws, code, reason, wasClean)),
            onError: (error) => this.ctx.waitUntil(this.handleSocketError(botKey, ws, error)),
          },
        });
        this._sockets[botKey] = { ws, mode };
        state.connected = true;
        state.ready = false;
        state.helloReceived = false;
        state.awaitingHeartbeatAck = false;
        state.expectingClose = false;
        state.socketOpenedAt = Date.now();
        state.nextHeartbeatAt = null;
        state.nextReconnectAt = null;
        state.nextWatchdogAt = Date.now() + 30000; // hello timeout watchdog
        state.lastError = null;
      } catch (e) {
        this.closeGatewaySocket(botKey, ws, "connection failed");
        state.connected = false;
        state.ready = false;
        state.lastError = `gateway connect failed: ${String(e).slice(0, 120)}`;
        state.nextReconnectAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, state.reconnectAttempts - 1));
      }
      this.saveState(state, botKey);
    });
  }

  // --- gateway event handling ---
  //
  // Keep callback aliases for callers while standard listeners feed
  // the same internal handleSocket* processing path.

  async webSocketMessage(ws, message) {
    const botKey = this.botKeyForSocket(ws);
    if (botKey) return this.handleSocketMessage(botKey, ws, message);
  }

  async handleSocketMessage(botKey, ws, message) {
    await this.runLocked(async () => {
      if (ws !== this._sockets[botKey]?.ws) return; // ignore a replaced connection
      let payload;
      try {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        payload = JSON.parse(text);
      } catch (_) {
        return;
      }
      const state = this.loadState(botKey);
      const { state: nextState, actions } = handleGatewayPayload(state, payload, {
        now: Date.now(),
      });
      if (!actions.some(action => action.type === "close_socket")) nextState.connected = true;
      this.saveState(nextState, botKey);
      await this.executeGatewayActions(botKey, ws, nextState, actions);
      await this.scheduleAlarmLocked();
    });
  }

  async executeGatewayActions(botKey, ws, state, actions) {
    const token = this.env[BOT_CONFIGS[botKey].tokenEnv];
    for (const action of actions) {
      if (action.type === "identify") {
        try {
          ws.send(
            JSON.stringify({ op: 2, d: identifyPayload(token) })
          );
        } catch (_) {
          /* socket went away; close handler will schedule a reconnect */
        }
      } else if (action.type === "resume") {
        if (state.sessionId && state.seq !== null) {
          try {
            ws.send(
              JSON.stringify({
                op: 6,
                d: {
                  token,
                  session_id: state.sessionId,
                  seq: state.seq,
                },
              })
            );
          } catch (_) {
            /* as above */
          }
        }
      } else if (action.type === "heartbeat") {
        try {
          ws.send(JSON.stringify({ op: 1, d: state.seq }));
        } catch (_) {
          /* as above */
        }
      } else if (action.type === "forward") {
        await this.enqueueForward(action.request, botKey);
      } else if (action.type === "close_socket") {
        this.closeGatewaySocket(botKey, ws, "reconnecting");
      }
      // "schedule_alarm" is handled by the caller after all actions.
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const botKey = this.botKeyForSocket(ws);
    if (botKey) return this.handleSocketClose(botKey, ws, code, reason, wasClean);
  }

  async handleSocketClose(botKey, ws, code, reason, wasClean) {
    await this.runLocked(async () => {
      if (ws !== this._sockets[botKey]?.ws) return;
      this._sockets[botKey] = null;
      const state = this.loadState(botKey);
      state.connected = false;
      state.ready = false;
      if (state.expectingClose && state.nextReconnectAt) {
        // The close was requested by the protocol handler (op 7 / op 9 /
        // heartbeat timeout); its reconnect decision is already saved.
        state.helloReceived = false;
        state.awaitingHeartbeatAck = false;
        state.expectingClose = false;
        this.saveState(state, botKey);
        await this.scheduleAlarmLocked();
        return;
      }
      if (
        state.nextReconnectAt &&
        state.nextReconnectAt > Date.now() &&
        (code === 1006 || code === 1011)
      ) {
        // An error handler already scheduled the reconnect; don't
        // double-count the attempt.
        this.saveState(state, botKey);
        await this.scheduleAlarmLocked();
        return;
      }
      const decision = reconnectDecisionForClose(state, code, Date.now());
      this.saveState(decision.state, botKey);
      await this.scheduleAlarmLocked();
    });
  }

  async webSocketError(ws, error) {
    const botKey = this.botKeyForSocket(ws);
    if (botKey) return this.handleSocketError(botKey, ws, error);
  }

  async handleSocketError(botKey, ws, error) {
    await this.runLocked(async () => {
      if (ws !== this._sockets[botKey]?.ws) return;
      this.closeGatewaySocket(botKey, ws, "socket error");
      const state = this.loadState(botKey);
      state.connected = false;
      state.ready = false;
      state.lastError = "gateway socket error";
      if (!state.nextReconnectAt || state.nextReconnectAt <= Date.now()) {
        const decision = reconnectDecisionForClose(state, 1006, Date.now());
        decision.state.lastError = "gateway socket error";
        this.saveState(decision.state, botKey);
        await this.scheduleAlarmLocked();
        return;
      }
      this.saveState(state, botKey);
      await this.scheduleAlarmLocked();
    });
  }

  // --- alarm: heartbeats, reconnects, outbox retries, watchdogs ---

  async alarm() {
    await this.runLocked(async () => {
      const now = Date.now();
      for (const botKey of BOT_KEYS) {
        await this.alarmBotLocked(botKey, now);
      }
      await this.scheduleAlarmLocked();
    });
    // Network delivery must never hold the protocol lock: a slow webhook
    // must not prevent heartbeat ACKs, reconnects, or status requests.
    this.ctx.waitUntil(this.flushOutbox());
  }

  // One bot's alarm pass. The decision tree is the single-bot one,
  // applied to this bot's own state and socket only: a bot that is not
  // configured is skipped entirely (no connection attempt, no error),
  // and one bot's reconnect or heartbeat never touches the other's
  // session.
  async alarmBotLocked(botKey, now) {
    if (!this.isConfigured(botKey)) return;
    let state = this.loadState(botKey);
    state.lastAlarmAt = now;
    this.saveState(state, botKey);

    const socket = this.getGatewaySocket(botKey);
    if (!socket) {
      state.connected = false;
      state.ready = false;
      this.saveState(state, botKey);
      if (
        this.isConfigured(botKey) && !state.reconnectBlocked &&
        (state.nextReconnectAt === null || state.nextReconnectAt <= now)
      ) {
        await this.connectLocked(botKey);
      }
    } else if (
      !state.ready && state.nextWatchdogAt && now >= state.nextWatchdogAt
    ) {
      // Hello/Identify/Resume did not complete in time: treat as dead.
      state.resumeMode = state.sessionId ? "resume" : "identify";
      state.helloReceived = false;
      state.nextHeartbeatAt = null;
      state.nextWatchdogAt = null;
      state.nextReconnectAt = now + 1000;
      state.connected = false;
      state.ready = false;
      state.lastError = "gateway handshake timeout";
      this.saveState(state, botKey);
      this.closeGatewaySocket(botKey, socket, "handshake timeout");
    } else if (
      state.helloReceived &&
      eventSilenceDecision(state, now).action === "reconnect"
    ) {
      // Heartbeats are ACKed but no dispatch has arrived for hours:
      // the socket is deaf. Close and resume (Hermes' liveness probe
      // does the equivalent against discord.py).
      state.resumeMode = state.sessionId ? "resume" : "identify";
      state.helloReceived = false;
      state.nextHeartbeatAt = null;
      state.nextWatchdogAt = null;
      state.nextReconnectAt = now + 1000;
      state.connected = false;
      state.ready = false;
      state.lastError = "gateway dispatch silence: forcing reconnect";
      this.saveState(state, botKey);
      this.closeGatewaySocket(botKey, socket, "dispatch silence");
    } else if (
      state.helloReceived &&
      state.nextHeartbeatAt &&
      state.nextHeartbeatAt <= now
    ) {
      const decision = heartbeatDecision(state, now);
      if (decision.action === "reconnect") {
        const next = decision.state;
        next.resumeMode = next.sessionId ? "resume" : "identify";
        next.helloReceived = false;
        next.nextHeartbeatAt = null;
        next.nextWatchdogAt = null;
        next.nextReconnectAt = now + 1000;
        next.connected = false;
        this.saveState(next, botKey);
        this.closeGatewaySocket(botKey, socket, "heartbeat ack timeout");
      } else if (decision.action === "send_heartbeat") {
        const next = decision.state;
        try {
          socket.send(JSON.stringify(decision.payload));
        } catch (e) {
          next.lastError = `heartbeat send failed: ${String(e).slice(0, 120)}`;
        }
        this.saveState(next, botKey);
      }
    }
  }

  // --- forwarding outbox (SQLite) ---

  insertOutbox(request, botKey) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO outbox (bot, request_id, body, attempts, next_attempt_at, created_at) " +
        "VALUES (?, ?, ?, 0, ?, ?)",
      botKey,
      request.request_id,
      JSON.stringify(request),
      now,
      now
    );
  }

  earliestOutboxAt(botKey) {
    const rows = botKey
      ? this.ctx.storage.sql
          .exec(
            "SELECT MIN(next_attempt_at) AS m FROM outbox WHERE bot = ?",
            botKey
          )
          .toArray()
      : this.ctx.storage.sql
          .exec("SELECT MIN(next_attempt_at) AS m FROM outbox")
          .toArray();
    const m = rows[0]?.m;
    return typeof m === "number" ? m : null;
  }

  async enqueueForward(request, botKey = PRIMARY_BOT) {
    // Resume replays: a message already forwarded (or already queued)
    // must not be filed twice — per bot, since the same Discord
    // message may legitimately be filed once by EACH bot. The outbox
    // primary key covers the queued case; forward_log covers the
    // completed case.
    const seen = this.ctx.storage.sql
      .exec(
        "SELECT request_id FROM forward_log WHERE bot = ? AND request_id = ?",
        botKey,
        request.request_id
      )
      .toArray();
    if (seen.length) return;
    this.insertOutbox(request, botKey);
    const state = this.loadState(botKey);
    // A replay may have hit INSERT OR IGNORE for a row already backing
    // off. Respect its stored Retry-After instead of arming a busy loop.
    state.nextOutboxAt = this.earliestOutboxAt(botKey);
    this.saveState(state, botKey);
    // The caller schedules the stored deadline after persisting this row.
  }

  // POST due outbox rows to dots-events, each in its own bot's forward
  // mode (see attemptForward). The receiver deduplicates by the body's
  // request_id, so retries never file a request twice.
  async flushOutbox() {
    this._flushPromises ||= {};
    return Promise.all(BOT_KEYS.map((botKey) => {
      if (!this.isConfigured(botKey)) return;
      if (this._flushPromises[botKey]) return this._flushPromises[botKey];
      const delivery = this.deliverBotOutbox(botKey).finally(async () => {
        delete this._flushPromises[botKey];
        await this.runLocked(() => this.scheduleAlarmLocked());
      });
      this._flushPromises[botKey] = delivery;
      return delivery;
    }));
  }

  async deliverOutbox() {
    return this.flushOutbox();
  }

  async deliverBotOutbox(botKey) {
    // Bound each bot independently. Suspended rows must not occupy the
    // other bot's batch, and a slow target must not delay its delivery.
    const rows = await this.runLocked(() => {
      const rows = this.ctx.storage.sql.exec(
        "SELECT bot, request_id, body, attempts FROM outbox " +
        "WHERE bot = ? AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 10",
        botKey, Date.now()
      ).toArray();
      const state = this.loadState(botKey);
      state.nextOutboxAt = this.earliestOutboxAt(botKey);
      this.saveState(state, botKey);
      return rows;
    });
    for (const row of rows) {
      const attempts = row.attempts + 1;
      let delayMs = Math.min(60000, 1000 * 2 ** attempts);
      const result = await attemptForward({
        env: this.env,
        bot: botKey,
        fetchImpl: fetch,
        requestId: row.request_id,
        body: row.body,
      });
      const ok = result.delivered;
      const error = result.error;
      if (result.retryAfterMs !== null && result.retryAfterMs !== undefined) {
        delayMs = Math.max(delayMs, result.retryAfterMs);
      }
      await this.runLocked(async () => {
        // Reload after I/O so concurrent ACK/session changes are never overwritten.
        const state = this.loadState(botKey);
        state.lastForwardError = error;
        if (ok || result.final || attempts >= MAX_FORWARD_ATTEMPTS) {
          this.ctx.storage.sql.exec(
            "DELETE FROM outbox WHERE bot = ? AND request_id = ?",
            botKey, row.request_id
          );
          if (ok || result.final) {
            // forward_log dedups replays for a week. A final trigger
            // failure (non-429 4xx) is logged here as failed — the
            // request can never be filed, so a replay must not file
            // it again — and counted as dropped below.
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO forward_log (bot, request_id, completed_at) VALUES (?, ?, ?)",
              botKey, row.request_id, Date.now()
            );
          }
          if (ok) {
            state.forwardedCount += 1;
            state.lastForwardAt = Date.now();
          } else state.droppedForwardCount += 1;
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE bot = ? AND request_id = ?",
            attempts, Date.now() + delayMs, botKey, row.request_id
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM forward_log WHERE completed_at < ?", Date.now() - 7 * 24 * 60 * 60 * 1000
        );
        state.nextOutboxAt = this.earliestOutboxAt(botKey);
        this.saveState(state, botKey);
        await this.scheduleAlarmLocked();
      });
    }
  }

}

// ---------- outbound send helpers (pure) ----------

const DISCORD_MESSAGE_LIMIT = 2000; // chars (UTF-16 units, like JS length)
// Hermes caps the number of chunks one logical send may fan out into so
// a degenerate response cannot flood a channel; overflow is replaced by
// a short notice, exactly like its _cap_split_chunks.
const MAX_SEND_CHUNKS = 10;
const MAX_RATE_LIMIT_WAIT_MS = 30000; // Hermes caps 429 sleeps at 30s

// Split content into <= limit chunks, preferring newline then space
// boundaries, never splitting a surrogate pair. Pure and exported for
// tests. Returns at most maxChunks entries; when the input needs more,
// the last entry is a truncation notice (Hermes pattern).
export function splitDiscordContent(
  content,
  limit = DISCORD_MESSAGE_LIMIT,
  maxChunks = MAX_SEND_CHUNKS
) {
  const text = String(content ?? "");
  if (text.length <= limit) return text ? [text] : [];
  const chunks = [];
  let rest = text;
  while (rest.length > limit && chunks.length < maxChunks - 1) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    // Do not split a surrogate pair across chunks.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[ \n]+/, "");
  }
  if (rest.length <= limit) {
    if (rest) chunks.push(rest);
    return chunks;
  }
  const roughDropped = rest.length - limit;
  const notice = `\n…(truncated: ${roughDropped} more characters not sent)`;
  let cut = limit - notice.length;
  if (rest.charCodeAt(cut - 1) >= 0xd800 && rest.charCodeAt(cut - 1) <= 0xdbff) cut--;
  const kept = rest.slice(0, cut);
  const dropped = rest.length - kept.length;
  let last = kept + `\n…(truncated: ${dropped} more characters not sent)`;
  if (last.length > limit) last = last.slice(0, limit);
  chunks.push(last);
  return chunks;
}

// Seconds to wait after a Discord 429, Hermes' extraction order: the
// JSON body's retry_after, then the Retry-After header, then
// X-RateLimit-Reset-After. Returns null when nothing usable is present.
export function parseRetryAfterSeconds({ body, headers } = {}) {
  const candidates = [];
  if (body && typeof body.retry_after === "number") {
    candidates.push(body.retry_after);
  }
  const get = (name) => {
    try {
      return headers?.get ? headers.get(name) : null;
    } catch (_) {
      return null;
    }
  };
  for (const raw of [get("retry-after"), get("x-ratelimit-reset-after")]) {
    if (raw !== null && raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) candidates.push(n);
    }
  }
  for (const n of candidates) {
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- bot avatar (pure helpers + admin endpoint) ----------

const MAX_AVATAR_BYTES = 8 * 1024 * 1024; // task-side cap for one avatar image

// Media type for an avatar image: magic bytes win; the URL (or a
// data: URI) extension is only a fallback hint. Returns null when the
// type is none of png/jpeg/gif/webp.
export function detectImageMediaType(bytes, urlHint) {
  if (bytes && bytes.length >= 4) {
    if (
      bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4e && bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes[0] === 0x47 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 &&
      bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  if (typeof urlHint === "string" && urlHint) {
    const dataMatch = /^data:(image\/(?:png|jpeg|gif|webp));/.exec(urlHint);
    if (dataMatch) return dataMatch[1];
    const clean = urlHint.split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith(".png")) return "image/png";
    if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
    if (clean.endsWith(".gif")) return "image/gif";
    if (clean.endsWith(".webp")) return "image/webp";
  }
  return null;
}

// PATCH the bot's own user object with a data-URI avatar. The fetch
// implementation is a parameter so tests can inject a fake (the
// Miniflare suite instead intercepts the real outbound fetch).
export async function patchBotAvatar(fetchImpl, token, mediaType, base64Data) {
  const res = await fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      avatar: `data:${mediaType};base64,${base64Data}`,
    }),
    redirect: "manual",
  });
  const text = await res.text();
  let user = null;
  try {
    user = JSON.parse(text);
  } catch (_) {
    /* non-JSON body: user stays null, bodyText carries the detail */
  }
  return { status: res.status, user, bodyText: text };
}

// Resolve the optional "bot" field of an admin request body to a bot
// key: absent (or null) selects the primary bot; a known bot name
// selects that bot; anything else is null, which callers turn into a
// 400 — a typo must never silently post as the wrong bot.
function selectBotKey(body) {
  const bot = body?.bot;
  if (bot === undefined || bot === null) return PRIMARY_BOT;
  return knownBot(bot) ? bot : null;
}

async function handleAvatar(env, request) {
  if (!isAdminKey(env, request)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const botKey = selectBotKey(body);
  if (!botKey) {
    return jsonResponse({ error: "unknown bot" }, 400);
  }
  const botToken = env[BOT_CONFIGS[botKey].tokenEnv];
  if (!botToken) {
    return jsonResponse({ error: "discord bot not configured" }, 500);
  }
  let bytes = null;
  let base64Data = null;
  let urlHint = null;
  if (typeof body?.image_url === "string" && body.image_url) {
    urlHint = body.image_url;
    let res;
    try {
      res = await fetch(urlHint, { redirect: "follow" });
    } catch (e) {
      return jsonResponse(
        { error: "image fetch failed", detail: String(e).slice(0, 120) },
        502
      );
    }
    if (!res.ok) {
      return jsonResponse(
        { error: `image fetch failed: HTTP ${res.status}` },
        502
      );
    }
    const declared = Number(res.headers.get("Content-Length") || "");
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
      return jsonResponse({ error: "image too large" }, 413);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AVATAR_BYTES) {
      return jsonResponse({ error: "image too large" }, 413);
    }
    bytes = new Uint8Array(buf);
    base64Data = b64encode(bytes);
  } else if (typeof body?.image_base64 === "string" && body.image_base64) {
    let raw = body.image_base64.trim();
    // Tolerate a full data: URI: keep its media type as the hint.
    const dataUri = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(raw);
    if (dataUri) {
      urlHint = `data:${dataUri[1]};base64,`;
      raw = dataUri[2];
    }
    base64Data = raw.replace(/\s+/g, "");
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data) ||
      base64Data.length % 4 !== 0
    ) {
      return jsonResponse({ error: "image_base64 is not valid base64" }, 400);
    }
    if (base64Data.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 4) {
      return jsonResponse({ error: "image too large" }, 413);
    }
    try {
      bytes = b64decode(base64Data);
    } catch (_) {
      return jsonResponse({ error: "image_base64 is not valid base64" }, 400);
    }
    if (bytes.length > MAX_AVATAR_BYTES) {
      return jsonResponse({ error: "image too large" }, 413);
    }
  } else {
    return jsonResponse(
      { error: "image_base64 or image_url is required" },
      400
    );
  }
  const mediaType = detectImageMediaType(bytes, urlHint);
  if (!mediaType) {
    return jsonResponse(
      { error: "unsupported image type (png/jpeg/gif/webp only)" },
      400
    );
  }
  const result = await patchBotAvatar(
    fetch,
    botToken,
    mediaType,
    base64Data
  );
  if (result.status !== 200) {
    return jsonResponse(
      {
        error: "discord avatar update failed",
        status: result.status,
        body: result.bodyText.slice(0, 500),
      },
      result.status >= 400 && result.status < 600 ? result.status : 502
    );
  }
  return jsonResponse(
    {
      status: 200,
      id: typeof result.user?.id === "string" ? result.user.id : null,
      username:
        typeof result.user?.username === "string" ? result.user.username : null,
      avatar:
        typeof result.user?.avatar === "string" ? result.user.avatar : null,
    },
    200
  );
}

// ---------- Worker front-end ----------

function gatewayStub(env) {
  return env.GATEWAY.get(env.GATEWAY.idFromName("global"));
}

async function handleSend(env, request) {
  if (!isAdminKey(env, request)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const botKey = selectBotKey(body);
  if (!botKey) {
    return jsonResponse({ error: "unknown bot" }, 400);
  }
  const channelId =
    typeof body?.channel_id === "string" ? body.channel_id.trim() : "";
  if (!/^\d{5,32}$/.test(channelId)) {
    return jsonResponse({ error: "channel_id is required" }, 400);
  }
  const rawContent = typeof body?.content === "string" ? body.content : "";
  if (!rawContent.trim()) {
    return jsonResponse({ error: "content is required" }, 400);
  }
  const botToken = env[BOT_CONFIGS[botKey].tokenEnv];
  if (!botToken) {
    return jsonResponse({ error: "discord bot not configured" }, 500);
  }
  // Split long content into <=2000-char messages instead of silently
  // truncating it (Hermes pattern); the split helper caps the fan-out.
  const chunks = splitDiscordContent(rawContent);
  const messageIds = [];
  let firstStatus = null;
  for (let i = 0; i < chunks.length; i++) {
    let res = null;
    let text = "";
    // Per-chunk delivery with bounded 429 handling: wait Discord's
    // retry_after (capped) and re-try the same chunk, up to 3 tries.
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(
        `${DISCORD_API_BASE}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: chunks[i], allowed_mentions: { parse: [] } }),
          redirect: "manual",
        }
      );
      text = await res.text();
      if (res.status !== 429 || attempt === 2) break;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        /* fall through to header-based delay */
      }
      const seconds = parseRetryAfterSeconds({
        body: parsed,
        headers: res.headers,
      });
      // A long rate limit is returned to the caller, never retried early.
      if (seconds !== null && seconds * 1000 > MAX_RATE_LIMIT_WAIT_MS) break;
      const waitMs = Math.max(250, Math.ceil((seconds ?? 1) * 1000));
      await sleepMs(waitMs);
    }
    if (!res.ok) {
      // Single-chunk sends stay byte-identical to Discord's response;
      // multi-chunk failures report how far delivery got.
      if (chunks.length === 1) {
        return new Response(text, {
          status: res.status,
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "application/json",
          },
        });
      }
      return jsonResponse(
        {
          error: "discord send failed",
          status: res.status,
          body: text.slice(0, 500),
          message_ids: messageIds,
          chunks_sent: messageIds.length,
          chunks_total: chunks.length,
        },
        res.status >= 400 && res.status < 600 ? res.status : 502
      );
    }
    if (firstStatus === null) firstStatus = res.status;
    if (chunks.length === 1) {
      return new Response(text, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
        },
      });
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.id === "string") messageIds.push(parsed.id);
    } catch (_) {
      /* non-JSON success body: nothing to collect */
    }
  }
  return jsonResponse(
    { message_ids: messageIds, chunks: chunks.length },
    firstStatus || 200
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return jsonResponse({ ok: true, service: SERVICE_NAME, version: SERVICE_VERSION });
      }
      if (url.pathname === "/status" && request.method === "GET") {
        // Public liveness view from the Durable Object: the primary
        // bot's {connected, ready} at top level (the legacy shape),
        // plus a "bots" map with each bot's {connected, ready,
        // configured} — no ids, no failure detail, no secrets.
        const res = await gatewayStub(env).fetch(
          "https://gateway/internal/status"
        );
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/connect" && request.method === "POST") {
        if (!isAdminKey(env, request)) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        // Optional JSON body {"bot": "<name>"} nudges one bot; no
        // body (or no bot field) nudges all of them. An unknown bot
        // name is a 400, never a silent nudge of the wrong bot.
        let bot = null;
        let rawBody = "";
        try {
          rawBody = await request.text();
        } catch (_) {
          /* unreadable body: treat as empty */
        }
        if (rawBody && rawBody.trim()) {
          let parsed = null;
          try {
            parsed = JSON.parse(rawBody);
          } catch (_) {
            return jsonResponse({ error: "invalid JSON body" }, 400);
          }
          if (parsed && parsed.bot !== undefined && parsed.bot !== null) {
            if (!knownBot(parsed.bot)) {
              return jsonResponse({ error: "unknown bot" }, 400);
            }
            bot = parsed.bot;
          }
        }
        const res = await gatewayStub(env).fetch(
          "https://gateway/internal/connect",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bot ? { bot } : {}),
          }
        );
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/send" && request.method === "POST") {
        return handleSend(env, request);
      }
      if (url.pathname === "/avatar" && request.method === "POST") {
        return handleAvatar(env, request);
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      return jsonResponse(
        { error: "internal error", detail: String(e).slice(0, 200) },
        500
      );
    }
  },
};

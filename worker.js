// discord-gateway — a shared Discord ear/mouth for the user's agent mesh.
//
// A single Durable Object (class Gateway, SQLite-backed, one global
// instance) keeps a persistent outbound WebSocket connection to the
// Discord Gateway, using fetch Upgrade and standard client WebSocket events.
// Outgoing sockets cannot hibernate, so connected objects incur duration
// charges. SQLite state survives restarts and alarms reconnect/resume.
//
// Inbound: MESSAGE_CREATE events that are DMs to the bot, or that mention
// the bot in a guild channel, are forwarded to the dots-events server.
// The body is
//   {"text": ..., "topic": "discord", "request_id": "discord-<message id>"}
// and the receiver deduplicates by request_id, so redelivery (Discord
// replays dispatches after a resume) is safe. Failed forwards are kept
// in a small SQLite outbox and retried from the alarm.
//
// The forward target depends on env FORWARD_MODE:
//   "claude-hook" (default): POST https://dots-events.0g0.xyz/claude-hook
//     signed with Standard Webhooks (HMAC-SHA256, whsec_ secret — the
//     same scheme dots-kick-events implements for its own /claude-hook
//     intake, so signatures are byte-for-byte compatible). Filed as a
//     request for Muse.
//   "trigger": POST https://dots-events.0g0.xyz/trigger with
//     Authorization: Bearer <EVENTS_TRIGGER_KEY>, no signing. Filed as a
//     request for the hub's subscribers (dots). A second deployment of
//     this same Worker (e.g. dots' own bot) uses this mode, since the
//     /claude-hook intake and its secret belong to Muse's side only.
//
// Outbound: agents reply into Discord through POST /send on this Worker
// (admin-key auth), which calls the Discord REST API with the bot token.
//
// Bindings / secrets (names only; values are never committed):
//   GATEWAY             — Durable Object namespace (class Gateway)
//   DISCORD_BOT_TOKEN   — secret; Discord bot token
//   FORWARD_MODE        — var; "claude-hook" (default) or "trigger"
//   CLAUDE_HOOK_SECRET  — secret; whsec_ HMAC secret for /claude-hook
//                         (FORWARD_MODE=claude-hook only)
//   EVENTS_TRIGGER_KEY  — secret; Bearer key for dots-events /trigger
//                         (FORWARD_MODE=trigger only)
//   ADMIN_KEY           — secret; key for POST /connect, /send, /avatar
//
// HTTP routes:
//   GET  /         service info (name / version)
//   GET  /status   public; exactly {"connected": bool, "ready": bool}
//   POST /connect  admin key; nudge the Durable Object to (re)connect;
//                  the response carries admin-only diagnostics
//                  {connected, ready, lastError, hasSession, lastDispatchAt}
//   POST /send     admin key; {"channel_id", "content"} -> Discord REST
//   POST /avatar   admin key; {"image_base64"} or {"image_url"} ->
//                  PATCH the bot's own avatar via Discord REST

import { DurableObject } from "cloudflare:workers";

const SERVICE_NAME = "discord-gateway";
const SERVICE_VERSION = "0.4.0";
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

// Whether a MESSAGE_CREATE message should be forwarded to Muse.
// Ignored: our own messages, any bot/webhook author, guild messages that
// neither are in a DM channel nor mention the bot.
export function shouldForwardMessage(message, botUserId) {
  if (!message || typeof message !== "object") return false;
  if (typeof message.content !== "string") return false;
  const author = message.author;
  if (!author || typeof author.id !== "string") return false;
  if (author.bot) return false; // other bots (and webhook authors)
  if (message.webhook_id) return false;
  if (botUserId && author.id === botUserId) return false; // our own messages
  const isDm = !message.guild_id || message.channel_type === 1 || message.channel_type === 3;
  if (isDm) return true;
  if (!botUserId) return false;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  if (mentions.some((m) => m && m.id === botUserId)) return true;
  return new RegExp(`<@!?${botUserId}>`).test(message.content);
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
// A deployment forwards in exactly one of two modes, chosen by the
// FORWARD_MODE env var:
//   "claude-hook" (default): signed Standard Webhooks POST to
//     dots-events' /claude-hook — files a request for Muse. Needs
//     CLAUDE_HOOK_SECRET.
//   "trigger": unsigned POST to dots-events' /trigger with
//     Authorization: Bearer <EVENTS_TRIGGER_KEY> — files a request for
//     the hub's subscribers (dots). For second-bot deployments, which
//     must not hold Muse's /claude-hook secret.
// Anything other than the exact string "trigger" selects claude-hook,
// so existing deployments keep their behavior when the var is unset.

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

// One forward delivery attempt for an outbox row. Pure apart from the
// injected fetch implementation, so the mode dispatch and the retry
// classification are unit-testable without a Durable Object. Returns:
//   { delivered, final, error, retryAfterMs }
// - delivered: the receiver accepted the request (HTTP 2xx).
// - final: retrying the identical body can never succeed, so the
//   caller drops the row now instead of at the attempt cap. Only
//   trigger mode produces this (a non-429 4xx rejects the request
//   itself); claude-hook mode retries every failure to the cap,
//   exactly as before.
// - retryAfterMs: the receiver's 429 delay hint, when one was given.
export async function attemptForward({ env, fetchImpl, requestId, body }) {
  if (forwardMode(env) === "trigger") {
    try {
      const res = await fetchImpl(EVENTS_TRIGGER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.EVENTS_TRIGGER_KEY}`,
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
    const signature = await signBody(env.CLAUDE_HOOK_SECRET, requestId, ts, body);
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
// The Durable Object persists one state object. handleGatewayPayload()
// maps (state, gateway payload) -> { state, actions } without touching
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
  return { GATEWAY_INTENTS, DEFAULT_GATEWAY_STATE, MAX_EVENT_SILENCE_MS };
}

// ---------- Durable Object: Gateway ----------

export class Gateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._lock = Promise.resolve();
    this._socket = null;
    this._socketMode = null;
    this._flushPromise = null;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS outbox (" +
        "request_id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
        "attempts INTEGER NOT NULL DEFAULT 0, " +
        "next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"
    );
    // Completed forwards, kept for a week: after a gateway Resume,
    // Discord replays recent events, and Hermes dedups those replays
    // with a local cache for the same reason. The receiver dedups by
    // request_id too, so this table only saves redundant round trips.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS forward_log (" +
        "request_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)"
    );
    // Self-start: if configured and no alarm is pending, arrange a
    // watchdog wake-up so a configured-but-disconnected object reconnects
    // on its own (e.g. after a deploy or object restart with no alarm).
    try {
      this.ctx.blockConcurrencyWhile(async () => {
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null && this.isConfigured()) {
          await this.ctx.storage.setAlarm(Date.now() + 60000);
        }
      });
    } catch (_) {
      /* best effort */
    }
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

  isConfigured() {
    return Boolean(this.env.DISCORD_BOT_TOKEN && forwardSecret(this.env));
  }

  loadState() {
    const rows = this.ctx.storage.sql
      .exec("SELECT key, value FROM kv WHERE key = 'gateway-state'")
      .toArray();
    if (!rows.length) return normalizeGatewayState(null);
    try {
      return normalizeGatewayState(JSON.parse(rows[0].value));
    } catch (_) {
      return normalizeGatewayState(null);
    }
  }

  saveState(state) {
    const normalized = normalizeGatewayState(state);
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value) VALUES ('gateway-state', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(normalized)
    );
    return normalized;
  }

  getGatewaySocket() {
    const ws = this._socket;
    return ws && (ws.readyState === 0 || ws.readyState === 1) ? ws : null;
  }

  closeGatewaySocket(ws, reason) {
    if (this._socket === ws) {
      this._socket = null;
      this._socketMode = null;
    }
    try { ws.close(4000, reason); } catch (_) { /* already closed */ }
  }

  statusSnapshot() {
    const state = this.loadState();
    const socket = this.getGatewaySocket();
    const connected = socket?.readyState === 1;
    return { connected, ready: connected && state.ready };
  }

  // Admin-only view: statusSnapshot() plus the recorded failure state,
  // so an operator holding the admin key can see WHY a connect attempt
  // is not landing (missing secrets, gateway lookup failure, close code
  // guidance, ...). Relayed only by the admin-gated POST /connect; the
  // public GET /status keeps returning exactly {connected, ready}.
  diagnosticsSnapshot() {
    const state = this.loadState();
    return {
      ...this.statusSnapshot(),
      lastError: state.lastError ?? null,
      hasSession:
        typeof state.sessionId === "string" && state.sessionId !== null,
      lastDispatchAt: state.lastDispatchAt ?? null,
    };
  }

  async scheduleAlarmLocked(state) {
    const now = Date.now();
    const candidates = [];
    if (state.nextOutboxAt && !this._flushPromise) candidates.push(state.nextOutboxAt);
    if (!state.reconnectBlocked && state.nextReconnectAt) candidates.push(state.nextReconnectAt);
    if (state.nextHeartbeatAt) candidates.push(state.nextHeartbeatAt);
    if (state.nextWatchdogAt) candidates.push(state.nextWatchdogAt);
    if (state.ready && state.lastDispatchAt) {
      candidates.push(state.lastDispatchAt + MAX_EVENT_SILENCE_MS);
    }
    if (this.isConfigured() && !state.reconnectBlocked) candidates.push(now + 60000); // watchdog
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
      return this.runLocked(async () => jsonResponse(this.statusSnapshot()));
    }
    if (url.pathname === "/internal/connect" && request.method === "POST") {
      return this.runLocked(async () => {
        await this.connectLocked({ manual: true });
        return jsonResponse(this.diagnosticsSnapshot());
      });
    }
    return new Response("not found", { status: 404 });
  }

  // --- connection management (callers hold the lock) ---

  async gatewayUrlForConnect(state) {
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
        headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
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

  async connectLocked({ manual = false } = {}) {
    let state = this.loadState();
    if (manual) state.reconnectBlocked = false;
    if (state.reconnectBlocked) return this.statusSnapshot();
    state.configured = this.isConfigured();
    if (!state.configured) {
      state.connected = false;
      state.ready = false;
      state.lastError = `missing DISCORD_BOT_TOKEN or ${forwardSecretName(this.env)}`;
      this.saveState(state);
      return this.statusSnapshot();
    }
    const existing = this.getGatewaySocket();
    if (existing) {
      state.connected = true;
      this.saveState(state);
      await this.scheduleAlarmLocked(state);
      return this.statusSnapshot();
    }
    if (this._socket) this.closeGatewaySocket(this._socket, "replaced");
    state.lastConnectAttemptAt = Date.now();
    state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
    const url = await this.gatewayUrlForConnect(state);
    try {
      const ws = await openGatewaySocket(fetch, url);
      this._socket = ws;
      this._socketMode = attachGatewaySocket({
        ctx: this.ctx,
        ws,
        handlers: {
          onMessage: (data) => this.ctx.waitUntil(this.handleSocketMessage(ws, data)),
          onClose: (code, reason, wasClean) =>
            this.ctx.waitUntil(this.handleSocketClose(ws, code, reason, wasClean)),
          onError: (error) => this.ctx.waitUntil(this.handleSocketError(ws, error)),
        },
      });
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
      if (this._socket) this.closeGatewaySocket(this._socket, "connection failed");
      state.connected = false;
      state.ready = false;
      state.lastError = `gateway connect failed: ${String(e).slice(0, 120)}`;
      const delay = Math.min(
        60000,
        1000 * 2 ** Math.min(6, state.reconnectAttempts - 1)
      );
      state.nextReconnectAt = Date.now() + delay;
    }
    state = this.saveState(state);
    await this.scheduleAlarmLocked(state);
    return this.statusSnapshot();
  }

  // --- gateway event handling ---
  //
  // Keep callback aliases for callers while standard listeners feed
  // the same internal handleSocket* processing path.

  async webSocketMessage(ws, message) {
    return this.handleSocketMessage(ws, message);
  }

  async handleSocketMessage(ws, message) {
    await this.runLocked(async () => {
      if (ws !== this._socket) return; // ignore a replaced connection
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
      const state = this.loadState();
      const { state: nextState, actions } = handleGatewayPayload(state, payload, {
        now: Date.now(),
      });
      if (!actions.some(action => action.type === "close_socket")) nextState.connected = true;
      this.saveState(nextState);
      await this.executeGatewayActions(ws, nextState, actions);
      const current = this.loadState();
      await this.scheduleAlarmLocked(current);
    });
  }

  async executeGatewayActions(ws, state, actions) {
    for (const action of actions) {
      if (action.type === "identify") {
        try {
          ws.send(
            JSON.stringify({ op: 2, d: identifyPayload(this.env.DISCORD_BOT_TOKEN) })
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
                  token: this.env.DISCORD_BOT_TOKEN,
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
        await this.enqueueForward(action.request);
      } else if (action.type === "close_socket") {
        this.closeGatewaySocket(ws, "reconnecting");
      }
      // "schedule_alarm" is handled by the caller after all actions.
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    return this.handleSocketClose(ws, code, reason, wasClean);
  }

  async handleSocketClose(ws, code, reason, wasClean) {
    await this.runLocked(async () => {
      if (ws !== this._socket) return;
      this._socket = null;
      this._socketMode = null;
      const state = this.loadState();
      state.connected = false;
      state.ready = false;
      if (state.expectingClose && state.nextReconnectAt) {
        // The close was requested by the protocol handler (op 7 / op 9 /
        // heartbeat timeout); its reconnect decision is already saved.
        state.helloReceived = false;
        state.awaitingHeartbeatAck = false;
        state.expectingClose = false;
        const saved = this.saveState(state);
        await this.scheduleAlarmLocked(saved);
        return;
      }
      if (
        state.nextReconnectAt &&
        state.nextReconnectAt > Date.now() &&
        (code === 1006 || code === 1011)
      ) {
        // An error handler already scheduled the reconnect; don't
        // double-count the attempt.
        const saved = this.saveState(state);
        await this.scheduleAlarmLocked(saved);
        return;
      }
      const decision = reconnectDecisionForClose(state, code, Date.now());
      const saved = this.saveState(decision.state);
      await this.scheduleAlarmLocked(saved);
    });
  }

  async webSocketError(ws, error) {
    return this.handleSocketError(ws, error);
  }

  async handleSocketError(ws, error) {
    await this.runLocked(async () => {
      if (ws !== this._socket) return;
      this.closeGatewaySocket(ws, "socket error");
      const state = this.loadState();
      state.connected = false;
      state.ready = false;
      state.lastError = "gateway socket error";
      if (!state.nextReconnectAt || state.nextReconnectAt <= Date.now()) {
        const decision = reconnectDecisionForClose(state, 1006, Date.now());
        decision.state.lastError = "gateway socket error";
        const saved = this.saveState(decision.state);
        await this.scheduleAlarmLocked(saved);
        return;
      }
      const saved = this.saveState(state);
      await this.scheduleAlarmLocked(saved);
    });
  }

  // --- alarm: heartbeats, reconnects, outbox retries, watchdogs ---

  async alarm() {
    await this.runLocked(async () => {
      const now = Date.now();
      let state = this.loadState();
      state.lastAlarmAt = now;
      this.saveState(state);

      const socket = this.getGatewaySocket();
      if (!socket) {
        state.connected = false;
        state.ready = false;
        this.saveState(state);
        if (
          this.isConfigured() && !state.reconnectBlocked &&
          (state.nextReconnectAt === null || state.nextReconnectAt <= Date.now())
        ) {
          await this.connectLocked();
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
        this.saveState(state);
        this.closeGatewaySocket(socket, "handshake timeout");
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
        this.saveState(state);
        this.closeGatewaySocket(socket, "dispatch silence");
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
          this.saveState(next);
          this.closeGatewaySocket(socket, "heartbeat ack timeout");
        } else if (decision.action === "send_heartbeat") {
          const next = decision.state;
          try {
            socket.send(JSON.stringify(decision.payload));
          } catch (e) {
            next.lastError = `heartbeat send failed: ${String(e).slice(0, 120)}`;
          }
          this.saveState(next);
        }
      }

      const current = this.loadState();
      await this.scheduleAlarmLocked(current);
    });
    // Network delivery must never hold the protocol lock: a slow webhook
    // must not prevent heartbeat ACKs, reconnects, or status requests.
    this.ctx.waitUntil(this.flushOutbox());
  }

  // --- forwarding outbox (SQLite) ---

  insertOutbox(request) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO outbox (request_id, body, attempts, next_attempt_at, created_at) " +
        "VALUES (?, ?, 0, ?, ?)",
      request.request_id,
      JSON.stringify(request),
      now,
      now
    );
  }

  earliestOutboxAt() {
    const rows = this.ctx.storage.sql
      .exec("SELECT MIN(next_attempt_at) AS m FROM outbox")
      .toArray();
    const m = rows[0]?.m;
    return typeof m === "number" ? m : null;
  }

  async enqueueForward(request) {
    // Resume replays: a message already forwarded (or already queued)
    // must not be filed twice. The outbox primary key covers the
    // queued case; forward_log covers the completed case.
    const seen = this.ctx.storage.sql
      .exec(
        "SELECT request_id FROM forward_log WHERE request_id = ?",
        request.request_id
      )
      .toArray();
    if (seen.length) return;
    this.insertOutbox(request);
    const state = this.loadState();
    state.nextOutboxAt = Date.now();
    this.saveState(state);
    // The caller arms an immediate alarm after persisting this row.
  }

  // POST due outbox rows to dots-events, in the deployment's forward
  // mode (see attemptForward). The receiver deduplicates by the body's
  // request_id, so retries never file a request twice.
  async flushOutbox() {
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this.deliverOutbox().finally(async () => {
      this._flushPromise = null;
      await this.runLocked(() => this.scheduleAlarmLocked(this.loadState()));
    });
    return this._flushPromise;
  }

  async deliverOutbox() {
    const secret = forwardSecret(this.env);
    if (!secret) {
      await this.runLocked(() => {
        const state = this.loadState();
        state.lastForwardError = `missing ${forwardSecretName(this.env)}`;
        state.nextOutboxAt = null;
        this.saveState(state);
      });
      return;
    }
    const rows = await this.runLocked(() => this.ctx.storage.sql.exec(
      "SELECT request_id, body, attempts FROM outbox " +
      "WHERE next_attempt_at <= ? ORDER BY created_at ASC LIMIT 10", Date.now()
    ).toArray());
    for (const row of rows) {
      const attempts = row.attempts + 1;
      let delayMs = Math.min(60000, 1000 * 2 ** attempts);
      const result = await attemptForward({
        env: this.env,
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
        const state = this.loadState();
        state.lastForwardError = error;
        if (ok || result.final || attempts >= MAX_FORWARD_ATTEMPTS) {
          this.ctx.storage.sql.exec("DELETE FROM outbox WHERE request_id = ?", row.request_id);
          if (ok || result.final) {
            // forward_log dedups replays for a week. A final trigger
            // failure (non-429 4xx) is logged here as failed — the
            // request can never be filed, so a replay must not file
            // it again — and counted as dropped below.
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO forward_log (request_id, completed_at) VALUES (?, ?)",
              row.request_id, Date.now()
            );
          }
          if (ok) {
            state.forwardedCount += 1;
            state.lastForwardAt = Date.now();
          } else state.droppedForwardCount += 1;
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE request_id = ?",
            attempts, Date.now() + delayMs, row.request_id
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM forward_log WHERE completed_at < ?", Date.now() - 7 * 24 * 60 * 60 * 1000
        );
        state.nextOutboxAt = this.earliestOutboxAt();
        this.saveState(state);
        await this.scheduleAlarmLocked(state);
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
  if (!env.DISCORD_BOT_TOKEN) {
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
    env.DISCORD_BOT_TOKEN,
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
  const channelId =
    typeof body?.channel_id === "string" ? body.channel_id.trim() : "";
  if (!/^\d{5,32}$/.test(channelId)) {
    return jsonResponse({ error: "channel_id is required" }, 400);
  }
  const rawContent = typeof body?.content === "string" ? body.content : "";
  if (!rawContent.trim()) {
    return jsonResponse({ error: "content is required" }, 400);
  }
  if (!env.DISCORD_BOT_TOKEN) {
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
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
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
        // Public liveness view from the Durable Object: exactly
        // {connected, ready} — no ids, no state detail, no secrets.
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
        const res = await gatewayStub(env).fetch(
          "https://gateway/internal/connect",
          { method: "POST" }
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

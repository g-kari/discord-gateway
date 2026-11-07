// Two real outbound WebSockets in one workerd Durable Object. All network
// requests terminate in local synthetic workers, never Discord or production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const fixture = source.replace("export default {", "const productionWorker = {") + `
export class TestGateway extends Gateway {
 async fetch(request) {
  const url = new URL(request.url), bot = url.searchParams.get('bot') || 'croissand';
  if (url.pathname === '/test/state') return Response.json(this.loadState(bot));
  if (url.pathname === '/test/patch') {
   const patch = await request.json();
   await this.runLocked(async () => {
    this.saveState({...this.loadState(bot), ...patch}, bot);
    await this.scheduleAlarmLocked();
   });
   return new Response('ok');
  }
  if (url.pathname === '/test/alarm') { await this.ctx.storage.deleteAlarm(); await this.alarm(); return new Response('ok'); }
  return super.fetch(request);
 }
}
export default productionWorker;`;

const mockSource = `
import {DurableObject} from 'cloudflare:workers';
export class DiscordMock extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.frames = []; this.hooks = []; this.hold = false; this.pending = 0; }
 async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/test/records') return Response.json({frames:this.frames, hooks:this.hooks, pending:this.pending});
  if (path === '/test/hold') { this.hold = true; return new Response('ok'); }
  if (path === '/test/release') { this.hold = false; this.release?.(); return new Response('ok'); }
  if (path === '/test/event') { this.ws.send(await req.text()); return new Response('ok'); }
  if (path === '/test/close') { this.ws.close(Number(await req.text()), 'synthetic close'); return new Response('ok'); }
  if (path === '/api/v10/gateway/bot') {
   const bot = req.headers.get('Authorization') === 'Bot synthetic-c' ? 'croissand' : 'ichihime';
   return Response.json({url:'wss://discord.test/gateway/' + bot});
  }
  if (path === '/claude-hook' || path === '/trigger') {
   this.hooks.push({path, body:await req.json(), authorization:req.headers.get('Authorization'), signature:req.headers.get('webhook-signature')});
   return new Response('ok');
  }
  if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
   this.pending++;
   try { if (this.hold) await new Promise(resolve => this.release = resolve); }
   finally { this.pending--; }
   const bot = path.endsWith('/croissand') ? 'croissand' : 'ichihime';
   const userId = bot === 'croissand' ? '999' : '888';
   const [client, server] = Object.values(new WebSocketPair()); this.ws = server;
   server.accept();
   server.addEventListener('message', e => {
    const frame = JSON.parse(e.data); this.frames.push(frame);
    if (frame.op === 2 || frame.op === 6) server.send(JSON.stringify({op:0,s:1,t:frame.op===2?'READY':'RESUMED',d:{session_id:'session-'+bot,resume_gateway_url:'wss://discord.test/gateway/'+bot,user:{id:userId,username:bot}}}));
    if (frame.op === 1) server.send(JSON.stringify({op:11}));
   });
   server.send(JSON.stringify({op:10,d:{heartbeat_interval:45000}}));
   return new Response(null,{status:101,webSocket:client});
  }
  return new Response('Unexpected local request',{status:500});
 }
}
export default {fetch(req,env) {
 const url = new URL(req.url);
 let bot;
 if (url.pathname.startsWith('/control/')) {
  bot = url.pathname.split('/')[2]; url.pathname = '/' + url.pathname.split('/').slice(3).join('/');
  req = new Request(url, req);
 } else if (url.pathname.startsWith('/gateway/')) bot = url.pathname.split('/')[2];
 else if (url.pathname === '/trigger') bot = 'ichihime';
 else bot = req.headers.get('Authorization') === 'Bot synthetic-i' ? 'ichihime' : 'croissand';
 return env.MOCK.get(env.MOCK.idFromName(bot)).fetch(req);
}};`;

let mf, stub, mock;
before(async () => {
  mf = new Miniflare({ workers: [{
    name: "gateway", modules: true, script: fixture, compatibilityDate: "2025-11-01",
    durableObjects: { GATEWAY: { className: "TestGateway", useSQLite: true } },
    bindings: {
      DISCORD_BOT_TOKEN: "synthetic-c", DISCORD_BOT_TOKEN_ICHICHIME: "synthetic-i",
      CLAUDE_HOOK_SECRET: "whsec_" + Buffer.alloc(32).toString("base64"),
      EVENTS_TRIGGER_KEY: "synthetic-trigger", ADMIN_KEY: "synthetic-admin",
    }, outboundService: "discord-mock",
  }, {
    name: "discord-mock", modules: true, script: mockSource,
    durableObjects: { MOCK: { className: "DiscordMock", useSQLite: true } },
  }] });
  const ns = await mf.getDurableObjectNamespace("GATEWAY");
  stub = ns.get(ns.idFromName("global"));
  mock = await mf.getWorker("discord-mock");
});
after(async () => {
  await mock?.fetch("https://local/control/croissand/test/release");
  await mf?.dispose();
});

async function control(bot, path, body) {
  return mock.fetch(`https://local/control/${bot}/test/${path}`,
    body === undefined ? {} : { method: "POST", body: String(body) });
}
async function records(bot) { return (await control(bot, "records")).json(); }
async function state(bot) { return (await stub.fetch(`https://local/test/state?bot=${bot}`)).json(); }
async function patch(bot, data) {
  return stub.fetch(`https://local/test/patch?bot=${bot}`, { method: "POST", body: JSON.stringify(data) });
}
async function eventually(check, message) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation blocked by the other bot's network I/O")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test("two sockets: each Identify and READY uses its own bot identity", async () => {
  const res = await mf.dispatchFetch("https://local/connect", {
    method: "POST", headers: { Authorization: "Bearer synthetic-admin" },
  });
  assert.equal(res.status, 200);
  for (const [bot, token, id] of [["croissand", "synthetic-c", "999"], ["ichihime", "synthetic-i", "888"]]) {
    await eventually(async () => (await state(bot)).ready, `${bot} did not reach READY`);
    assert.equal((await records(bot)).frames[0].d.token, token);
    assert.equal((await state(bot)).botUserId, id);
    assert.equal((await state(bot)).sessionId, `session-${bot}`);
  }
});

test("two sockets: the same mention is forwarded once per bot to its own target", async () => {
  const event = JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: {
    id: "shared-message", channel_id: "123", guild_id: "456",
    content: "<@999> <@888> hello", mentions: [{ id: "999" }, { id: "888" }],
    author: { id: "111", username: "test" },
  } });
  for (const bot of ["croissand", "ichihime"]) await control(bot, "event", event);
  await stub.fetch("https://local/test/alarm");
  for (const bot of ["croissand", "ichihime"]) {
    await eventually(async () => (await state(bot)).forwardedCount === 1, `${bot} did not forward`);
    await control(bot, "event", event);
  }
  await stub.fetch("https://local/test/alarm");
  const c = (await records("croissand")).hooks, i = (await records("ichihime")).hooks;
  assert.equal(c.length, 1); assert.equal(i.length, 1);
  assert.equal(c[0].path, "/claude-hook"); assert.ok(c[0].signature);
  assert.equal(i[0].path, "/trigger"); assert.equal(i[0].authorization, "Bearer synthetic-trigger");
  assert.equal(c[0].body.request_id, i[0].body.request_id);
});

test("two sockets: a stalled Upgrade does not block the other bot's real heartbeat and ACK", async () => {
  // Arm the barrier before close: a real earlier alarm may reconnect
  // immediately, so holding it afterwards would race that reconnect.
  await control("croissand", "hold");
  await control("croissand", "close", 4000);
  await eventually(async () => !(await state("croissand")).connected, "close not handled");
  const heartbeatCount = (await records("ichihime")).frames.filter((f) => f.op === 1).length;
  const ackAt = (await state("ichihime")).lastHeartbeatAckAt;
  await patch("croissand", { nextReconnectAt: Date.now() - 1 });
  await patch("ichihime", { nextHeartbeatAt: Date.now() + 300, awaitingHeartbeatAck: false });
  const alarm = stub.fetch("https://local/test/alarm");
  await eventually(async () => (await records("croissand")).pending === 1, "Upgrade did not start");
  try {
    await promptly(alarm);
    const res = await promptly(mf.dispatchFetch("https://local/status"));
    assert.equal((await res.json()).bots.ichihime.ready, true);
    await eventually(async () => (await records("ichihime")).frames.filter((f) => f.op === 1).length > heartbeatCount, "heartbeat blocked");
    await eventually(async () => (await state("ichihime")).lastHeartbeatAckAt > (ackAt ?? 0), "ACK blocked");
  } finally { await control("croissand", "release"); await alarm; }
  await eventually(async () => (await state("croissand")).ready, "Resume did not complete");
  assert.ok((await records("croissand")).frames.some((f) => f.op === 6 && f.d.session_id === "session-croissand"));
});

test("two sockets: fatal close stops only the affected bot", async () => {
  await control("ichihime", "close", 4011);
  await eventually(async () => (await state("ichihime")).reconnectBlocked, "fatal stop not latched");
  const before = (await records("ichihime")).frames.length;
  await stub.fetch("https://local/test/alarm");
  assert.equal((await state("croissand")).ready, true);
  assert.equal((await records("ichihime")).frames.length, before);
  assert.equal((await state("ichihime")).nextReconnectAt, null);
});

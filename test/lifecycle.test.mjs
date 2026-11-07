// Local workerd integration: every network request stays inside these two workers.
// No Discord token, real Discord connection, or production hook is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const fixture = workerSource.replace('export default {', 'const productionWorker = {') + `
export class TestGateway extends Gateway {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/test/state') return Response.json(this.loadState());
  if (path === '/test/patch') {
   await this.runLocked(async () => {const state=this.saveState({...this.loadState(), ...await request.json()});await this.scheduleAlarmLocked(state);});
   return new Response('ok');
  }
  if (path === '/test/alarm') { await this.ctx.storage.deleteAlarm(); await this.alarm(); return new Response('ok'); }
  if (path === '/test/alarm-at') return Response.json(await this.ctx.storage.getAlarm());
  if (path === '/test/outbox') return Response.json(this.ctx.storage.sql.exec('SELECT * FROM outbox').toArray());
  return super.fetch(request);
 }
}
export default productionWorker;`;
const mockDiscord = `
import {DurableObject} from 'cloudflare:workers';
export class DiscordMock extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.frames=[];this.hooks=[];this.hold=false;this.ws=null;}

 async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/test/records') return Response.json({frames:this.frames,hooks:this.hooks});
  if (path === '/test/release') {this.hold=false;this.release?.();return new Response('ok');}
  if (path === '/test/hold') {this.hold=true;return new Response('ok');}
  if (path === '/test/event') {this.ws.send(await req.text());return new Response('ok');}
  if (path === '/test/close') {this.ws.close(Number(await req.text()),'synthetic close');return new Response('ok');}
  if (path === '/api/v10/gateway/bot') return Response.json({url:'wss://gateway.test'});
  if (path === '/claude-hook') {
   this.hooks.push(await req.json());
   if(this.hold) await new Promise(resolve => this.release=resolve);
   return new Response('ok');
  }
  if(req.headers.get('Upgrade')?.toLowerCase()==='websocket') {
   const [client,server]=Object.values(new WebSocketPair()); this.ws=server;server.accept();
   server.addEventListener('message', e=>{
    const frame=JSON.parse(e.data); this.frames.push(frame);
    if(frame.op===2 || frame.op===6) server.send(JSON.stringify({op:0,s:1,t:frame.op===2?'READY':'RESUMED',d:{session_id:'synthetic-session',resume_gateway_url:'wss://gateway.test',user:{id:'999',username:'test'}}}));
    if(frame.op===1) server.send(JSON.stringify({op:11}));
   });
   server.send(JSON.stringify({op:10,d:{heartbeat_interval:45000}}));
   return new Response(null,{status:101,webSocket:client});
  }
  return new Response('Unexpected network request',{status:500});
 }
 };
export default {fetch(req,env){return env.MOCK.get(env.MOCK.idFromName('mock')).fetch(req);}};`;
let mf, stub, mock;
before(async () => {
 mf = new Miniflare({workers:[{
  name:'gateway',modules:true,script:fixture,compatibilityDate:'2025-11-01',
  durableObjects:{GATEWAY:{className:'TestGateway',useSQLite:true}},
  bindings:{DISCORD_BOT_TOKEN:'synthetic-token',CLAUDE_HOOK_SECRET:'whsec_'+Buffer.alloc(32).toString('base64'),ADMIN_KEY:'synthetic-admin'},
  outboundService:'discord-mock'
 },{name:'discord-mock',modules:true,script:mockDiscord,durableObjects:{MOCK:{className:'DiscordMock',useSQLite:true}}}]});
 const ns=await mf.getDurableObjectNamespace('GATEWAY');
 stub=ns.get(ns.idFromName('global'));
 mock=await mf.getWorker('discord-mock');
});
after(async()=>{await mock?.fetch('http://mock/test/release');await mf?.dispose();});
async function state(){return (await stub.fetch('https://local/test/state')).json();}
async function patch(data){return stub.fetch('https://local/test/patch',{method:'POST',body:JSON.stringify(data)});}
async function event(data){return mock.fetch('https://mock/test/event',{method:'POST',body:JSON.stringify(data)});}
async function records(){return (await mock.fetch('https://mock/test/records')).json();}
async function eventually(check, message){
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,10));}
 assert.fail(message);
}
async function connect(){return mf.dispatchFetch('http://local/connect',{method:'POST',headers:{Authorization:'Bearer synthetic-admin'}});}

test('runtime: outgoing socket receives Hello, sends Identify, and reaches READY',async()=>{
 assert.equal((await connect()).status,200);
 await eventually(async()=>(await state()).ready,'READY was not received');
 const status=await mf.dispatchFetch('http://local/status');
 const statusBody=await status.json();
 assert.equal(statusBody.connected,true);
 assert.equal(statusBody.ready,true);
 assert.equal(statusBody.bots.croissand.ready,true);
 assert.equal(statusBody.bots.ichihime.configured,false);
 const s=await state();
 assert.equal(s.nextWatchdogAt,null);
 assert.equal(s.sessionId,'synthetic-session');
 assert.equal((await records()).frames[0].op,2);
});

test('runtime: a healthy alarm has no expired handshake/watchdog deadline',async()=>{
 await patch({nextHeartbeatAt:Date.now()+45000,lastDispatchAt:Date.now()});
 await stub.fetch('https://local/test/alarm');
 const at=await (await stub.fetch('https://local/test/alarm-at')).json();
 assert.ok(at-Date.now()>1000,'healthy alarm would spin at 250ms');
});

test('runtime: a stalled webhook does not block ACK, heartbeat, status or overwrite seq',async()=>{
 await mock.fetch('https://mock/test/hold');
 await event({op:0,s:2,t:'MESSAGE_CREATE',d:{id:'123',channel_id:'456',content:'if True:\n    if True:\n        print(1)',author:{id:'111',username:'test'}}});
 await eventually(async()=>(await records()).hooks.length===1,'webhook not attempted');
 await event({op:11});
 await event({op:0,s:3,t:'GUILD_CREATE',d:{}});
 await eventually(async()=>(await state()).seq===3,'dispatch blocked by webhook');
 const r=await mf.dispatchFetch('http://local/status');
 assert.equal(r.status,200);
 await patch({nextHeartbeatAt:Date.now()+500,awaitingHeartbeatAck:false});
 // A real subsequent alarm must run while delivery from the first is pending.
 await eventually(async()=>(await records()).frames.some(f=>f.op===1),'heartbeat blocked by webhook');
 await eventually(async()=>(await state()).awaitingHeartbeatAck===false,'ACK blocked by webhook');
 await mock.fetch('https://mock/test/release');
 await eventually(async()=>(await state()).forwardedCount===1,'forward not completed');
 assert.equal((await state()).seq,3);
 assert.ok((await records()).hooks[0].text.endsWith('if True:\n    if True:\n        print(1)'));
 await event({op:0,s:4,t:'MESSAGE_CREATE',d:{id:'123',channel_id:'456',content:'duplicate',author:{id:'111',username:'test'}}});
 await eventually(async()=>(await state()).seq===4,'duplicate not processed');
 await stub.fetch('https://local/test/alarm');
 assert.equal((await records()).hooks.length,1);
});

test('runtime: remote transient close reconnects using Resume',async()=>{
 await mock.fetch('https://mock/test/close',{method:'POST',body:'4000'});
 await eventually(async()=>!(await state()).connected,'close not processed');
 await patch({nextReconnectAt:Date.now()-1});
 await stub.fetch('https://local/test/alarm');
 await eventually(async()=>(await state()).ready,'Resume not completed');
 assert.ok((await records()).frames.some(f=>f.op===6&&f.d.session_id==='synthetic-session'));
});

test('runtime: fatal 4011 stops automatic retries, manual connect can retry',async()=>{
 await mock.fetch('https://mock/test/close',{method:'POST',body:'4011'});
 await eventually(async()=>(await state()).reconnectBlocked,'fatal close not latched');
 const before=(await records()).frames.length;
 await stub.fetch('https://local/test/alarm');
 assert.equal((await records()).frames.length,before);
 assert.equal((await state()).nextReconnectAt,null);
 await connect();
 await eventually(async()=>(await state()).ready,'manual reconnect did not recover');
 assert.equal((await state()).reconnectBlocked,false);
});

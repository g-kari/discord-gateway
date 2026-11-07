import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root=process.env.CONNECTOR_ROOT || resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(root,'package.json'));
const { generateKeyPair, exportJWK, SignJWT }=await import(pathToFileURL(require.resolve('jose')));
const { Miniflare }=await import(process.env.MINIFLARE_MODULE || 'miniflare');
const { connectionLedgerName }=await import(pathToFileURL(join(root,'src/connection-policy.mjs')));
const script=await readFile(join(root,'dist/shared-worker.mjs'),'utf8');
const ISSUER='https://id.0g0.xyz', RESOURCE='https://reply.test/mcp';
const G='111111111111111111', A='222222222222222222', B='222222222222222223', OWNER='synthetic-owner';
const row=(connection_id,client_id,bot,channel)=>({connection_id,client_id,owner_subject:OWNER,bot,enabled:true,ledger_mode:'isolated-v1',targets:[{guild_id:G,channel_id:channel,type:0}]});
const policies=[row('alpha','synthetic-client-a','ichihime',A),row('beta','synthetic-client-b','croissand',B)];
const keys=await generateKeyPair('ES256');const jwk={...await exportJWK(keys.publicKey),kid:'independent-synthetic',use:'sig',alg:'ES256'};
async function sign(patch={}){const seconds=Math.floor(Date.now()/1000);return new SignJWT({iss:ISSUER,aud:RESOURCE,sub:OWNER,cid:policies[0].client_id,scope:'discord:reply:read discord:reply:send',iat:seconds,exp:seconds+900,jti:'synthetic-only',...patch}).setProtectedHeader({alg:'ES256',kid:jwk.kid}).sign(keys.privateKey);}
const gateway=`let calls=[];export default {async fetch(req){if(new URL(req.url).pathname==='/records')return Response.json(calls);const body=await req.json();calls.push({body,path:new URL(req.url).pathname,auth:req.headers.get('Authorization')});if(body.content==='simulate unknown')return new Response('uncertain',{status:503});return Response.json({id:String(444444444444444440n+BigInt(calls.length)),channel_id:body.channel_id,author:{id:body.bot==='ichihime'?'1568548424519913482':'1568508479293890673'}},{status:201});}}`;
async function start(persist,rows=policies){const network=[];const mf=new Miniflare({durableObjectsPersist:persist,workers:[
{name:'ingress',modules:true,serviceBindings:{REPLY:'reply'},script:`export default {fetch(r,e){const h=new Headers(r.headers);h.set('Host',new URL(r.url).host);return e.REPLY.fetch(new Request(r,{headers:h}));}}`},
{name:'reply',modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],durableObjects:{REPLY_LEDGER:{className:'ReplyLedger',useSQLite:true}},bindings:{AUTH_MODE:'0g0-id-jwt',AUTH_SERVER_URL:ISSUER,MCP_SERVER_URL:RESOURCE,CONNECTION_POLICIES_JSON:JSON.stringify(rows),SEND_ENABLED:'true',GATEWAY_ADMIN_KEY:'synthetic-not-real'},serviceBindings:{GATEWAY_SERVICE:'gateway'},outboundService:req=>{network.push({url:req.url,authorization:req.headers.get('Authorization')});return req.url===ISSUER+'/.well-known/jwks.json'?Response.json({keys:[jwk]}):new Response('blocked',{status:500});}},
{name:'gateway',modules:true,script:gateway}
]});await mf.ready;return {mf,network};}
async function rpc(f,method,params,token,extra={}){const res=await f.mf.dispatchFetch(RESOURCE,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const raw=await res.text();let body;try{body=JSON.parse(raw);}catch{const line=raw.split('\n').find(x=>x.startsWith('data: '));body=line?JSON.parse(line.slice(6)):null;}return {status:res.status,body,raw};}
async function tool(f,name,args,token,extra){const r=await rpc(f,'tools/call',{name,arguments:args},token,extra);let value;try{value=JSON.parse(r.body.result.content[0].text);}catch{}return {...r,value};}
const input=(channel=A,source='333333333333333333',content='Synthetic audit reply')=>({source_message_id:source,channel_url:`https://discord.com/channels/${G}/${channel}`,content});
async function records(f){return (await (await f.mf.getWorker('gateway')).fetch('https://gateway.internal/records')).json();}
test('independent shared workerd: signed cid binding, isolated SQLite receipts, client rotation and Bot conflict',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'shared-independent-jwt-'));let f;
 try{
  f=await start(persist);const ta=await sign(),tb=await sign({cid:policies[1].client_id});
  assert.equal((await rpc(f,'tools/list',{})).status,401);
  for(const [patch,status] of [[{cid:'unregistered'},403],[{sub:'outsider'},403],[{aud:'https://other.test/mcp'},401],[{cid:undefined},401],[{scope:'discord:reply:send'},403]])assert.equal((await rpc(f,'tools/list',{},await sign(patch))).status,status);
  const a=await tool(f,'discord_reply_status',{},ta,{'X-Client-Id':policies[1].client_id});const b=await tool(f,'discord_reply_status',{},tb);
  assert.equal(a.value.bot,'ichihime');assert.deepEqual(a.value.allowed_channels,[input(A).channel_url]);assert.equal(b.value.bot,'croissand');assert.deepEqual(b.value.allowed_channels,[input(B).channel_url]);assert.ok(!a.raw.includes('synthetic-client-b'));assert.ok(!a.raw.includes('croissand'));
  assert.equal((await tool(f,'discord_send_reply',input(B),ta)).value.error,'target_not_allowed');
  assert.equal((await tool(f,'discord_send_reply',input(A),tb)).value.error,'target_not_allowed');
  assert.equal((await tool(f,'discord_send_reply',input(A),await sign({scope:'discord:reply:read'}))).value.error,'insufficient_scope');
  const extra=await tool(f,'discord_send_reply',{...input(A),bot:'croissand'},ta);assert.ok(extra.body.error||extra.body.result?.isError);
  assert.equal((await records(f)).length,0);
  const sa=await tool(f,'discord_send_reply',input(A),ta);const sb=await tool(f,'discord_send_reply',input(B),tb);assert.equal(sa.value.status,'sent');assert.equal(sb.value.status,'sent');
  assert.deepEqual((await records(f)).map(x=>x.body.bot),['ichihime','croissand']);
  await tool(f,'discord_send_reply',input(A),ta);await tool(f,'discord_send_reply',input(B),tb);assert.equal((await records(f)).length,2);
  assert.equal((await tool(f,'discord_reply_receipt',input(B),ta)).value.error,'target_not_allowed');
  const uncertain=input(A,'333333333333333334','simulate unknown');assert.equal((await tool(f,'discord_send_reply',uncertain,ta)).value.status,'unknown');assert.equal((await records(f)).length,3);
  assert.deepEqual(f.network,[{url:ISSUER+'/.well-known/jwks.json',authorization:null}]);
  await f.mf.dispose();f=null;
  const rotated=[{...policies[0],client_id:'replacement-client'},policies[1]];f=await start(persist,rotated);
  assert.equal((await rpc(f,'tools/list',{},ta)).status,403);
  const tr=await sign({cid:'replacement-client'});assert.deepEqual((await tool(f,'discord_send_reply',input(A),tr)).value,sa.value);assert.equal((await tool(f,'discord_send_reply',uncertain,tr)).value.status,'unknown');assert.equal((await records(f)).length,0);
  await f.mf.dispose();f=null;
  f=await start(persist,[{...rotated[0],bot:'croissand'},rotated[1]]);
  assert.equal((await tool(f,'discord_send_reply',input(A),tr)).value.error,'source_already_used_with_different_reply');assert.equal((await records(f)).length,0);
 }finally{await f?.mf.dispose();await rm(persist,{recursive:true,force:true});}
});
test('independent shared workerd: private DO route must match the current authenticated connection',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'shared-independent-route-'));let f;
 try{
  f=await start(persist);const ns=await f.mf.getDurableObjectNamespace('REPLY_LEDGER','reply');
  const wrong=ns.get(ns.idFromName(await connectionLedgerName(policies[0])));
  const request={operation:'send',auth:{userId:OWNER,clientId:policies[1].client_id,scope:['discord:reply:read','discord:reply:send'],expiresAt:Date.now()/1000+600},input:input(B)};
  const res=await wrong.fetch('https://ledger.internal/',{method:'POST',body:JSON.stringify(request)});assert.equal(res.status,400);assert.equal((await res.json()).error,'connection_route_mismatch');assert.equal((await records(f)).length,0);
 }finally{await f?.mf.dispose();await rm(persist,{recursive:true,force:true});}
});

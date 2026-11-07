import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Standard npm installation uses miniflare. MINIFLARE_MODULE can select a
// preinstalled official test dependency without modifying another checkout.
const { Miniflare } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const G='111111111111111111',C='222222222222222222',OWNER='synthetic-owner';
const ORIGIN='https://reply.test';
const authScript = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class SyntheticAuth extends WorkerEntrypoint {
 async validateToken(resource,token) {
  if(token==='throws')throw new Error('synthetic failure');
  if(!['owner','read-only','outsider','wrong-audience','expired'].includes(token))return null;
  return {audience:token==='wrong-audience'?'https://other.test/mcp':resource,
   expiresAt:token==='expired'?1:Math.floor(Date.now()/1000)+600,
   scope:token==='read-only'?['discord:reply:read']:['discord:reply:read','discord:reply:send'],
   userId:token==='outsider'?'outsider':'synthetic-owner',clientId:'synthetic-client',props:{userId:'synthetic-owner'}};
 }
 fetch(){return new Response('fixture');}
}`;
const gatewayScript = `let calls=[];export default {async fetch(req){
 const url=new URL(req.url);if(url.pathname==='/records')return Response.json(calls);
 const body=await req.json();calls.push({path:url.pathname,body,auth:req.headers.get('Authorization')});
 return Response.json({id:String(444444444444444440n+BigInt(calls.length)),channel_id:body.channel_id,author:{id:'1568548424519913482'}},{status:201});
}}`;
let mf,persist;
async function start(){const script=await readFile(new URL('../dist/worker.mjs',import.meta.url),'utf8');mf=new Miniflare({durableObjectsPersist:persist,workers:[{name:'synthetic-ingress',modules:true,serviceBindings:{REPLY:'reply'},script:`export default {fetch(req,env){const headers=new Headers(req.headers);headers.set('Host',new URL(req.url).host);return env.REPLY.fetch(new Request(req,{headers}));}}`},{
 name:'reply',modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
 durableObjects:{REPLY_LEDGER:{className:'ReplyLedger',useSQLite:true}},
 bindings:{OWNER_SUBJECT:OWNER,ALLOWED_TARGETS_JSON:JSON.stringify([{guild_id:G,channel_id:C,type:0}]),SEND_ENABLED:'true',GATEWAY_ADMIN_KEY:'synthetic-key-not-a-credential',MCP_SERVER_URL:ORIGIN+'/mcp',AUTH_SERVER_URL:'https://auth.test'},
 serviceBindings:{AUTH_SERVER:'synthetic-auth',GATEWAY_SERVICE:'synthetic-gateway'},outboundService:()=>new Response('Outbound networking is disabled',{status:500})
},{name:'synthetic-auth',modules:true,script:authScript},{name:'synthetic-gateway',modules:true,script:gatewayScript}]});await mf.ready;}
before(async()=>{persist=await mkdtemp(join(tmpdir(),'ichihime-reply-test-'));await start();});
after(async()=>{await mf?.dispose();await rm(persist,{recursive:true,force:true});});
async function request(body,token,extra={}){return mf.dispatchFetch(ORIGIN+'/mcp',{method:'POST',headers:{Host:'reply.test','Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});}
async function rpc(method,params={},token='owner',extra={}){const res=await request({jsonrpc:'2.0',id:1,method,params},token,extra);const raw=await res.text();let parsed;try{parsed=JSON.parse(raw);}catch{const data=raw.split('\n').find(l=>l.startsWith('data: '));if(data)parsed=JSON.parse(data.slice(6));}return {status:res.status,headers:res.headers,body:parsed,raw};}
async function tool(name,args={},token='owner'){const r=await rpc('tools/call',{name,arguments:args},token);const content=r.body?.result?.content?.[0]?.text;let value=null;try{value=content?JSON.parse(content):null;}catch{}return {...r,value};}
function input(source='333333333333333333'){return {source_message_id:source,channel_url:`https://discord.com/channels/${G}/${C}`,content:'synthetic runtime reply'};}
async function records(){return (await (await mf.getWorker('synthetic-gateway')).fetch('https://gateway.internal/records')).json();}
test('runtime OAuth: missing token is 401 with resource metadata challenge',async()=>{const r=await request({jsonrpc:'2.0',id:1,method:'tools/list'},undefined);assert.equal(r.status,401);assert.match(r.headers.get('WWW-Authenticate'),/resource_metadata/);assert.equal((await records()).length,0);});
test('runtime OAuth: protected resource discovery advertises only configured resource',async()=>{const r=await mf.dispatchFetch(ORIGIN+'/.well-known/oauth-protected-resource/mcp');assert.equal(r.status,200);const data=await r.json();assert.equal(data.resource,ORIGIN+'/mcp');assert.deepEqual(data.authorization_servers,['https://auth.test']);});
test('runtime OAuth: invalid, wrong-audience, expired and failing validator denied',async()=>{for(const [token,status] of [['invalid',401],['wrong-audience',401],['expired',401],['throws',503],['outsider',403]]){const r=await request({jsonrpc:'2.0',id:1,method:'tools/list'},token);assert.equal(r.status,status,token);}assert.equal((await records()).length,0);});
test('runtime MCP: initialize, tool discovery and owner status succeed',async()=>{const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-test',version:'1'}});assert.equal(init.status,200,init.raw);assert.equal(init.body.result.serverInfo.name,'ichihime-discord-reply');const list=await rpc('tools/list');assert.deepEqual(list.body.result.tools.map(t=>t.name).sort(),['discord_reply_receipt','discord_reply_status','discord_send_reply'].sort());const status=await tool('discord_reply_status');assert.equal(status.value.bot,'ichihime');assert.equal(status.value.source_identity_verified,false);assert.equal(status.headers.get('Access-Control-Allow-Origin'),null);});
test('runtime MCP: modern protocol discovers tools without legacy initialize',async()=>{const list=await rpc('tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}},'owner',{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'});assert.equal(list.status,200,list.raw);assert.equal(list.body.result.tools.length,3);});
test('runtime MCP: read-only token cannot send, other target/bot/mention rejected',async()=>{const read=await tool('discord_send_reply',input(),'read-only');assert.equal(read.value.error,'insufficient_scope');const target=await tool('discord_send_reply',{...input(),channel_url:`https://discord.com/channels/${G}/222222222222222223`});assert.equal(target.value.error,'target_not_allowed');const extra=await tool('discord_send_reply',{...input(),bot:'croissand'});assert.ok(extra.body.error||extra.body.result.isError);const mention=await tool('discord_send_reply',{...input(),content:'@everyone'});assert.equal(mention.value.error,'mentions_not_allowed');assert.equal((await records()).length,0);});
test('runtime MCP: bad browser origin rejected without wildcard CORS',async()=>{const r=await rpc('tools/list',{},'owner',{Origin:'https://untrusted.test'});assert.equal(r.status,403);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);});
test('runtime SQLite ledger: send once, fixed bot/private secret, dedup survives new requests',async()=>{const first=await tool('discord_send_reply',input());assert.equal(first.value?.status,'sent',first.raw);assert.equal((await records()).length,1);const row=(await records())[0];assert.equal(row.path,'/send');assert.equal(row.body.bot,'ichihime');assert.equal(row.body.channel_id,C);assert.equal(row.auth,'Bearer synthetic-key-not-a-credential');assert.ok(!first.raw.includes('synthetic-key'));const second=await tool('discord_send_reply',input());assert.deepEqual(second.value,first.value);const receipt=await tool('discord_reply_receipt',input());assert.deepEqual(receipt.value,first.value);assert.equal((await records()).length,1);});
test('runtime SQLite ledger: changed payload cannot evade same-source dedup',async()=>{const r=await tool('discord_send_reply',{...input(),content:'changed'});assert.equal(r.value.error,'source_already_used_with_different_reply');assert.equal((await records()).length,1);});
test('runtime SQLite ledger: receipt survives full runtime restart and no gateway call',async()=>{await mf.dispose();await start();assert.equal((await records()).length,0);const r=await tool('discord_send_reply',input());assert.equal(r.value.status,'sent');assert.equal((await records()).length,0);});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.CONNECTOR_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { SharedReplyLedger } = await import(pathToFileURL(resolve(root, 'src/shared-ledger.mjs')));
const { connectionPolicies, connectionLedgerName, connectionIdentity, resolveConnection } = await import(pathToFileURL(resolve(root, 'src/connection-policy.mjs')));
const { READ_SCOPE, WRITE_SCOPE } = await import(pathToFileURL(resolve(root, 'src/core.mjs')));
const OWNER='synthetic-owner', G='111111111111111111', C='222222222222222222', M='333333333333333333';
const input={source_message_id:M,channel_url:`https://discord.com/channels/${G}/${C}`,content:'Synthetic audit reply'};
const row={connection_id:'alpha',client_id:'synthetic-client',owner_subject:OWNER,bot:'ichihime',enabled:true,ledger_mode:'isolated-v1',targets:[{guild_id:G,channel_id:C,type:0}]};
const principal=()=>({userId:OWNER,clientId:row.client_id,scope:[READ_SCOPE,WRITE_SCOPE],expiresAt:Date.now()/1000+600});
const id=name=>({name,toString:()=>name,equals:other=>String(other)===name});
class Storage { constructor(){this.rows=new Map();} async get(k){return structuredClone(this.rows.get(k));} async put(k,v){this.rows.set(k,structuredClone(v));} async transaction(fn){const value=await fn(this);this.reserved=true;return value;} }
async function rig(policies=[row], routedRow=policies[0]){
  let calls=0;
  const env={CONNECTION_POLICIES_JSON:JSON.stringify(policies),SEND_ENABLED:'true',GATEWAY_ADMIN_KEY:'synthetic-not-real',REPLY_LEDGER:{idFromName:id},GATEWAY_SERVICE:{fetch:async(_url,opts)=>{calls++;const sent=JSON.parse(opts.body);return Response.json({id:'444444444444444444',channel_id:sent.channel_id,author:{id:sent.bot==='ichihime'?'1568548424519913482':'1568508479293890673'}});}}};
  const ctx={storage:new Storage(),id:id(await connectionLedgerName(routedRow))};
  const ledger=new SharedReplyLedger(ctx,env);
  async function invoke(auth=principal(),operation='send',payload=input){const response=await ledger.fetch(new Request('https://ledger.internal/',{method:'POST',body:JSON.stringify({operation,auth,input:payload})}));return {status:response.status,body:await response.json()};}
  return {env,ctx,ledger,invoke,calls:()=>calls};
}
test('audit: mismatched routed durable object must not dispatch or reserve',async()=>{
  const beta={...row,connection_id:'beta'};
  const r=await rig([beta],row); // Ingress chose alpha, policy now selects beta.
  const result=await r.invoke();
  assert.equal(r.calls(),0,`wrong namespace dispatched: ${JSON.stringify(result)}`);
  assert.equal(r.ctx.storage.rows.size,0);
});
test('audit: policy revocation during post-reservation hash must prevent dispatch',async()=>{
  const r=await rig();
  const original=crypto.subtle.digest.bind(crypto.subtle);let hashes=0,postReservationHashes=0,changed=false;
  crypto.subtle.digest=async(...args)=>{hashes++;if(r.ctx.storage.reserved && ++postReservationHashes===3){changed=true;r.env.CONNECTION_POLICIES_JSON=JSON.stringify([{...row,enabled:false}]);}return original(...args);};
  let result;
  try{result=await r.invoke();}finally{delete crypto.subtle.digest;}
  assert.equal(changed,true,'must exercise the final asynchronous hash after reservation');
  assert.equal(r.calls(),0,`revoked policy dispatched after ${hashes} hashes: ${JSON.stringify(result)}`);
});
test('audit: expired auth during post-reservation hash must prevent dispatch',async()=>{
  const r=await rig();const auth=principal();const original=crypto.subtle.digest.bind(crypto.subtle), originalNow=Date.now;let hashes=0,postReservationHashes=0,changed=false;
  crypto.subtle.digest=async(...args)=>{hashes++;if(r.ctx.storage.reserved && ++postReservationHashes===3){changed=true;Date.now=()=>Math.ceil(auth.expiresAt*1000)+1;}return original(...args);};
  let result;try{result=await r.invoke(auth);}finally{delete crypto.subtle.digest;Date.now=originalNow;}
  assert.equal(changed,true,'must exercise the final asynchronous hash after reservation');
  assert.equal(r.calls(),0,`expired authentication dispatched: ${JSON.stringify(result)}`);
});
test('audit: no token or client-controlled extras can choose a different Bot',async()=>{
  for(const field of ['bot','client_id','connection_id','owner_subject','auth','gateway_url','admin_key']){
    const r=await rig();const result=await r.invoke(principal(),'send',{...input,[field]:'croissand'});assert.equal(r.calls(),0,field);assert.equal(result.status,400,field);
  }
});
test('audit: complete policy validation rejects duplicate client or connection ID and reserved legacy mismatches',()=>{
  const invalid=[ [row,{...row,connection_id:'beta'}], [row,{...row,client_id:'second-client'}], [{...row,connection_id:'ichihime-legacy'}], [{...row,ledger_mode:'legacy-ichihime-v1'}], [{...row,connection_id:'ichihime-legacy',ledger_mode:'legacy-ichihime-v1',bot:'croissand'}], [{...row,targets:[...row.targets,{guild_id:'111111111111111112',channel_id:C,type:0}]}] ];
  for(const rows of invalid) assert.throws(()=>connectionPolicies({CONNECTION_POLICIES_JSON:JSON.stringify(rows)}));
});
test('audit: clientId replacement retains stable namespace and key, Bot replacement changes only digest',async()=>{
  const a=await connectionLedgerName(row),b=await connectionLedgerName({...row,client_id:'replacement'});assert.equal(a,b);
  const reply={source_message_id:M,guild_id:G,channel_id:C,content:input.content};
  const x=await connectionIdentity(reply,row),y=await connectionIdentity(reply,{...row,client_id:'replacement'}),z=await connectionIdentity(reply,{...row,bot:'croissand'});
  assert.deepEqual(x,y);assert.equal(x.key,z.key);assert.notEqual(x.digest,z.digest);
});
test('audit: disabled connection and global disable permit no send',async()=>{
  for(const disabled of ['connection','global']){
    const r=await rig(disabled==='connection'?[{...row,enabled:false}]:[row]);if(disabled==='global')r.env.SEND_ENABLED='false';await r.invoke();assert.equal(r.calls(),0);
  }
});
test('audit: owner/read/send/expiry boundaries fail closed',async()=>{
  for(const auth of [{...principal(),clientId:'missing'}, {...principal(),userId:'another-owner'}, {...principal(),scope:[READ_SCOPE]}, {...principal(),scope:[WRITE_SCOPE]}, {...principal(),expiresAt:0}]){
    const r=await rig();await r.invoke(auth);assert.equal(r.calls(),0);
  }
});

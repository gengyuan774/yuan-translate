import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {loginMember} from '../src/member.js';
import {handle} from '../src/worker.js';
import {acquireLease,releaseLease,reserve} from '../src/service-ledger.js';
import {realtimeRelay} from '../src/realtime-relay.js';
async function fixture(){
 const f=environment();
 const create=async()=>{const a=await createVerifiedAccountSession(f.env,{provider:'email',subject:crypto.randomUUID()+'@example.test',label:'recording-qa'});const cookie=a.cookie.split(';')[0];await loginMember(req('/api/member/login',{},cookie),f.env,'test-member-code');return {cookie,id:a.user.id};};
 const a=await create(),b=await create();
 const api=(path,body,cookie=a.cookie,headers={})=>handle(req(path,body,cookie,headers),()=>{throw Error('No provider call expected');},f.env);
 const recording=(owner,cookie=a.cookie)=>req('/api/openai/realtime?owner='+owner,undefined,cookie,{Upgrade:'websocket'});
 return {...f,a,b,api,recording};
}
test('preflight identifies another recording without spending an attempt, permits its owner and recovers after expiry',async t=>{
 const f=await fixture(),owner=crypto.randomUUID(),lease=await acquireLease(f.recording(owner),f.env);
 const busy=await (await f.api('/api/openai/status?owner='+crypto.randomUUID())).json();
 assert.equal(busy.code,'recording_busy');assert.equal(busy.recording.id,lease.id);
 assert.deepEqual(await (await f.api('/api/openai/status?owner='+owner)).json(),{available:true});
 assert.equal(f.sql.prepare("SELECT count(*) n FROM usage_buckets WHERE id LIKE 'realtime-%'").get().n,0);
 t.mock.method(Date,'now',()=>busy.recording.expiresAt+1);
 assert.deepEqual(await (await f.api('/api/openai/status')).json(),{available:true});
});
test('explicit takeover is account scoped and conditional; the replaced sender cannot reserve audio or release a newer lease',async()=>{
 const f=await fixture(),old=await acquireLease(f.recording(crypto.randomUUID()),f.env);
 assert.equal((await f.api('/api/openai/recording/takeover',{leaseId:old.id},f.b.cookie)).status,409);
 assert.equal((await f.api('/api/openai/recording/takeover',{leaseId:old.id})).status,200);
 const fresh=await acquireLease(f.recording(crypto.randomUUID()),f.env);
 await assert.rejects(()=>reserve(f.recording(crypto.randomUUID()),f.env,{kind:'audio',audioMs:1000,lease:old}),e=>e.status===402);
 await releaseLease(f.env,old);
 assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts WHERE account_id=?').get(f.a.id).lease_id,fresh.id);
 assert.equal((await f.api('/api/openai/recording/takeover',{leaseId:old.id})).status,409);
 assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts WHERE account_id=?').get(f.a.id).lease_id,fresh.id);
});
test('page exit releases only this account and owner; unauthenticated and cross-origin release/takeover are denied',async()=>{
 const f=await fixture(),owner=crypto.randomUUID(),lease=await acquireLease(f.recording(owner),f.env);
 await f.api('/api/openai/recording/release',{owner},f.b.cookie);
 await f.api('/api/openai/recording/release',{owner:crypto.randomUUID()});
 assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts WHERE account_id=?').get(f.a.id).lease_id,lease.id);
 for(const path of ['/api/openai/recording/release','/api/openai/recording/takeover']){
  assert.equal((await f.api(path,{owner,leaseId:lease.id},'')).status,401);
  assert.equal((await f.api(path,{owner,leaseId:lease.id},f.a.cookie,{Origin:'https://untrusted.example'})).status,403);
 }
 assert.equal((await f.api('/api/openai/recording/release',{owner})).status,200);
 assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts WHERE account_id=?').get(f.a.id).lease_id,null);
});
class Socket{
 constructor(){this.readyState=1;this.listeners={};this.sent=[];}
 accept(){}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 send(raw){this.sent.push(JSON.parse(raw));}
 fire(type){for(const fn of this.listeners[type]||[])fn({});}
 close(){if(this.readyState===3)return;this.readyState=3;this.fire('close');}
}
test('socket cleanup is registered with the Worker lifetime and releases the lease after the client disconnects',async()=>{
 const f=await fixture(),upstream=new Socket(),server=new Socket(),client=new Socket(),tasks=[];
 await realtimeRelay(f.recording(crypto.randomUUID()),f.env,async()=>({webSocket:upstream}),{pairFactory:()=>({0:client,1:server}),upgrade:s=>({status:101,webSocket:s}),waitUntil:task=>tasks.push(task)});
 server.close();assert.ok(tasks.length>0);await Promise.all(tasks);
 assert.equal(upstream.readyState,3);assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts WHERE account_id=?').get(f.a.id).lease_id,null);
});
test('a competing start receives its actionable conflict over WebSocket without invoking the provider',async()=>{
 const f=await fixture(),old=await acquireLease(f.recording(crypto.randomUUID()),f.env),server=new Socket(),client=new Socket();
 const r=await realtimeRelay(f.recording(crypto.randomUUID()),f.env,()=>{assert.fail('no provider connection for competing start');},{pairFactory:()=>({0:client,1:server}),upgrade:s=>({status:101,webSocket:s})});
 assert.equal(r.status,101);assert.equal(server.sent[0].error.code,'recording_busy');assert.equal(server.sent[0].error.recording.id,old.id);
});

import {TRANSLATION_INSTRUCTIONS} from '../src/translation-prompt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
import {digest} from '../src/security-common.js';
import {reserve,settle,myUsage,acquireLease,releaseLease,recoverExpired,serviceBudgetState,serviceState} from '../src/service-ledger.js';
import {MeteredAudio,realtimeRelay,safeSession} from '../src/realtime-relay.js';
import {textCost,audioCost,PERIOD_MS} from '../src/service-plans.js';
async function fixture(){
 const f=environment(),{env}=f;env.MEMBER_DAILY_TEXT_LIMIT='5000';
 // Emulate D1's transaction queue when requests from multiple isolates race.
 const original=env.DB.batch.bind(env.DB);let previous=Promise.resolve();env.DB.batch=items=>{const job=previous.then(()=>original(items));previous=job.catch(()=>{});return job;};
 const a=await createVerifiedAccountSession(env,{provider:'email',subject:crypto.randomUUID()+'@test.example',label:'usage-qa'}),cookie=a.cookie.split(';')[0];
 await handle(req('/api/member/login',{code:'test-member-code'},cookie),()=>{throw Error('No API expected');},env);
 const token='ab'.repeat(32);env.MEMBER_ADMIN_TOKEN_SHA256=await digest(token);
 const request=req('/api/openai/responses',{input:'hello',instructions:TRANSLATION_INSTRUCTIONS},cookie,{'X-Access-Mode':'member'});
 const api=(path,body)=>handle(req(path,body,cookie,{'X-Access-Mode':'member'}),()=>{throw Error('No API expected');},env);
 const admin=(path,body)=>handle(req(path,body,'',{Authorization:'Bearer '+token}),()=>{throw Error('No API expected');},env);
 const configure=async(overrides={})=>{const response=await admin('/api/admin/costs/settings',{warningCents:null,hardCents:null,paused:false,expectedRevision:(await serviceBudgetState(env)).revision,reason:'isolated test',...overrides});assert.equal(response.status,200,await response.clone().text());return response.json();};
 return {...f,account:a.user,cookie,request,api,admin,configure};
}
test('admin reads ten accounts together without mixing usage or changing their balances',async()=>{
 const f=await fixture(),expected=new Map();
 for(let i=0;i<9;i++){
  const a=await createVerifiedAccountSession(f.env,{provider:'email',subject:'admin-list-'+i+'@example.test',label:'account-'+i});
  await handle(req('/api/member/login',{code:'test-member-code'},a.cookie.split(';')[0]),()=>{throw Error('No provider calls');},f.env);
  await myUsage(req('/',undefined,a.cookie.split(';')[0]),f.env);
  f.sql.prepare('UPDATE plan_balances SET audio_used=? WHERE account_id=?').run((i+1)*60000,a.user.id);expected.set(a.user.id,i+1);
 }
 expected.set(f.account.id,0);
 const result=await f.admin('/api/admin/costs');assert.equal(result.status,200);const data=await result.json();
 assert.equal(data.accounts.length,10);assert.equal(data.next,null);
 assert.deepEqual(data.accounts.map(a=>a.id),[...expected.keys()].sort());
 for(const account of data.accounts){assert.equal(account.usage.usedMinutes,expected.get(account.id));assert.equal(account.membership.tier,'regular');}
 for(const row of f.sql.prepare('SELECT account_id,audio_used FROM plan_balances').all())assert.equal(row.audio_used/60000,expected.get(row.account_id));
});
test('commercial plans publish 30/80 prices and enforce 30 hours plus 10 summaries by default',async()=>{
 const f=await fixture();const usage=await myUsage(f.request,f.env);
 assert.equal(usage.quotaEnforced,true);assert.equal(usage.minutes,1800);assert.equal(usage.summaries,10);
 const html=readFileSync(new URL('../public/membership.html',import.meta.url),'utf8');assert.match(html,/30<small>元/);assert.match(html,/80<small>元/);assert.match(html,/不限次数/);
});
test('quota reservation, actual settlement, failure refund and duplicate settlement are atomic',async()=>{
 const f=await fixture();await f.configure();
 const row=await reserve(f.request,f.env,{kind:'text',inputTokens:2000,outputTokens:500});
 assert.equal((await myUsage(f.request,f.env)).inputReserved,2000);
 await settle(f.env,row,{success:true,usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10}}});
 await settle(f.env,row,{success:true,usage:{input_tokens:100,output_tokens:20}});
 let u=await myUsage(f.request,f.env);assert.equal(u.inputUsed,100);assert.equal(u.outputUsed,20);assert.equal(u.inputReserved,0);
 const failed=await reserve(f.request,f.env,{kind:'text',inputTokens:2000,outputTokens:500});await settle(f.env,failed,{providerAccepted:true});
 u=await myUsage(f.request,f.env);assert.equal(u.inputUsed,100);assert.equal(u.inputReserved,0);
 assert.equal(f.sql.prepare('SELECT spent FROM service_budgets').get().spent,textCost(100,20,10)+failed.reserved_cost);
});
test('text concurrency caps survive simultaneous reservations and quota exhaustion never calls provider',async()=>{
 const f=await fixture();await f.configure();
 const results=await Promise.allSettled(Array.from({length:8},()=>reserve(f.request,f.env,{kind:'text',inputTokens:1000,outputTokens:10})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
 for(const r of results)if(r.status==='fulfilled')await settle(f.env,r.value,{});
 f.sql.prepare('UPDATE plan_balances SET audio_used=108000000').run();let called=false;
 await assert.rejects(()=>acquireLease(f.request,f.env),e=>e.status===402);
 const lease={id:'expired',accountId:f.account.id};await assert.rejects(()=>reserve(f.request,f.env,{kind:'audio',audioMs:1000,lease}),e=>e.status===402);assert.equal(called,false);
});
test('one account has only one recording lease; another account is independent; stale lease expires',async t=>{
 const f=await fixture(),lease=await acquireLease(f.request,f.env);
 await assert.rejects(()=>acquireLease(f.request,f.env),e=>e.status===409);
 const other=await createVerifiedAccountSession(f.env,{provider:'email',subject:'other@test.example',label:'other'}),c=other.cookie.split(';')[0];await handle(req('/api/member/login',{code:'test-member-code'},c),()=>{},f.env);
 const lease2=await acquireLease(req('/',undefined,c),f.env);assert.notEqual(lease.accountId,lease2.accountId);
 await releaseLease(f.env,lease);assert.ok(await acquireLease(f.request,f.env));
 const now=Date.now();t.mock.method(Date,'now',()=>now+91000);assert.ok(await acquireLease(f.request,f.env));
});
test('audio is not sent until reserved; failed turns refund time, successful turns count once',async()=>{
 const f=await fixture();await f.configure();const lease=await acquireLease(f.request,f.env),sent=[],events=[];
 const audio=new MeteredAudio(f.request,f.env,lease,e=>sent.push(e),e=>events.push(e));
 await audio.append(Buffer.alloc(48000).toString('base64'));assert.equal(sent.length,0);await audio.commit();assert.equal(sent.length,2);
 await audio.event({type:'input_audio_buffer.committed',item_id:'turn1'});
 await audio.event({type:'conversation.item.input_audio_transcription.completed',item_id:'turn1',transcript:'Hello'});
 await audio.event({type:'conversation.item.input_audio_transcription.completed',item_id:'turn1',transcript:'Hello'});
 assert.equal((await myUsage(f.request,f.env)).usedMinutes,1/60);
 await audio.append(Buffer.alloc(48000).toString('base64'));await audio.commit();await audio.event({type:'input_audio_buffer.committed',item_id:'turn2'});await audio.event({type:'conversation.item.input_audio_transcription.failed',item_id:'turn2'});
 assert.equal((await myUsage(f.request,f.env)).usedMinutes,1/60);
 f.sql.exec('UPDATE plan_balances SET audio_used=108000000');await audio.append(Buffer.alloc(48000).toString('base64'));const count=sent.length;await assert.rejects(()=>audio.commit(),e=>e.status===402);assert.equal(sent.length,count);
 await audio.close();
});
test('audio validates frame size and accelerated streams; upstream metadata cannot reveal secrets',async()=>{
 const f=await fixture(),lease=await acquireLease(f.request,f.env),events=[];
 const audio=new MeteredAudio(f.request,f.env,lease,()=>{},e=>events.push(e));
 await assert.rejects(()=>audio.append('%%%'));await assert.rejects(()=>audio.append(Buffer.alloc(3).toString('base64')));
 await audio.event({type:'session.updated',session:{client_secret:f.env.OPENAI_API_KEY}});await audio.event({type:'error',error:{message:f.env.OPENAI_API_KEY}});
 assert.doesNotMatch(JSON.stringify(events),/sk-test/);assert.deepEqual(events[0],{type:'session.updated'});
 await audio.close();
});
test('global budget counts concurrent reservations and rejects before sending; alerts persist and stop switch works',async()=>{
 const f=await fixture();await f.configure({warningCents:1,hardCents:2});
 const row=await reserve(f.request,f.env,{kind:'text',inputTokens:1000,outputTokens:1000});
 await assert.rejects(()=>reserve(f.request,f.env,{kind:'text',inputTokens:1000,outputTokens:1000}),e=>e.status===402);
 assert.ok(f.sql.prepare("SELECT id FROM service_alerts WHERE kind='warning'").get());
 await settle(f.env,row,{});await f.configure({paused:true});await assert.rejects(()=>reserve(f.request,f.env,{kind:'text',inputTokens:10,outputTokens:1}),e=>e.status===503);
});
test('expired reservations refund user quotas but retain conservative provider cost and new periods reset allowance',async t=>{
 const f=await fixture();await f.configure();const row=await reserve(f.request,f.env,{kind:'text',inputTokens:2000,outputTokens:500});
 const now=Date.now();t.mock.method(Date,'now',()=>now+121000);await recoverExpired(f.env);
 assert.equal(f.sql.prepare('SELECT input_reserved FROM service_periods').get().input_reserved,0);assert.equal(f.sql.prepare('SELECT spent FROM service_budgets').get().spent,row.reserved_cost);
 f.sql.exec('UPDATE service_periods SET audio_used=3500000');const member={accountId:f.account.id,tier:'regular'};const before=await serviceState(f.env,member);t.mock.method(Date,'now',()=>now+PERIOD_MS+1);const after=await serviceState(f.env,member);assert.equal(after.period.audio_used,0);assert.equal(after.period.start,before.period.start+PERIOD_MS);
});
test('admin session uses one-use ticket and HttpOnly cookie; account and cross-site requests have no admin access',async()=>{
 const f=await fixture();assert.equal((await f.api('/api/admin/costs')).status,401);
 const first=await f.admin('/api/admin/cost-session',{});assert.equal(first.status,200);const {ticket}=await first.json();
 const redeem=await f.api('/api/admin/cost-session/redeem',{ticket});assert.equal(redeem.status,200);const cookie=redeem.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
 assert.equal((await f.api('/api/admin/cost-session/redeem',{ticket})).status,401);
 const access=await handle(req('/api/admin/costs',undefined,cookie.split(';')[0]),()=>{},f.env);assert.equal(access.status,200);
 const cross=await handle(req('/api/admin/costs/settings',{},cookie,{Origin:'https://evil.test'}),()=>{},f.env);assert.equal(cross.status,403);
});
test('restrictions expire and compensation is audited once without subtracting real provider fees',async t=>{
 const f=await fixture();await f.configure();const row=await reserve(f.request,f.env,{kind:'text',inputTokens:100,outputTokens:50});await settle(f.env,row,{success:true,usage:{input_tokens:80,output_tokens:20}});
 const before=await serviceBudgetState(f.env);for(let i=0;i<2;i++)assert.equal((await f.admin('/api/admin/costs/compensate',{requestId:row.id,reason:'translation failed for user'})).status,200);
 assert.equal((await myUsage(f.request,f.env)).inputUsed,0);assert.equal((await serviceBudgetState(f.env)).spentCny,before.spentCny);
 assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM security_audit WHERE action='service_quota_compensated'").get().n,1);
 const until=Date.now()+60000;assert.equal((await f.admin('/api/admin/costs/restrict',{accountId:f.account.id,until,expectedUntil:0,reason:'suspected abuse'})).status,200);
 await assert.rejects(()=>reserve(f.request,f.env,{kind:'text',inputTokens:10,outputTokens:1}),e=>e.status===403);
 t.mock.method(Date,'now',()=>until+1);assert.ok(await reserve(f.request,f.env,{kind:'text',inputTokens:10,outputTokens:1}));
});
test('streamed success records provider usage; interrupted generation refunds allowance and keeps provider estimate',async()=>{
 const f=await fixture();
 const upstream=async()=>new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'你好'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:80,output_tokens:2}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
 const request=req('/api/openai/responses',{instructions:TRANSLATION_INSTRUCTIONS,input:'Hello',stream:true,max_output_tokens:100},f.cookie,{'X-Access-Mode':'member'});
 const retry=request.clone();const r=await handle(request,upstream,f.env);assert.equal(r.status,200);assert.match(await r.text(),/你好/);
 assert.equal((await myUsage(f.request,f.env)).inputUsed,80);
 const bad=await handle(retry,async()=>new Response('data: {"type":"response.output_text.delta","delta":"半句"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),f.env);await bad.text();assert.equal((await myUsage(f.request,f.env)).inputReserved,0);
});
test('old ephemeral token endpoint cannot bypass the relay or expose a reusable credential',async()=>{
 const f=await fixture();let called=false;const r=await handle(req('/api/openai/token',{sourceLanguage:'en'},f.cookie,{'X-Access-Mode':'member'}),()=>{called=true;},f.env);assert.equal(r.status,410);assert.equal(called,false);
});

class Socket{
  constructor(){this.readyState=1;this.sent=[];this.listeners={};}
  accept(){this.accepted=true;}
  addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);}
  send(data){if(this.readyState!==1)throw Error('socket closed');this.sent.push(JSON.parse(data));}
  fire(type,data){for(const handler of this.listeners[type]||[])handler({data:typeof data==='string'?data:JSON.stringify(data)});}
  close(){if(this.readyState===3)return;this.readyState=3;this.fire('close','');}
}
test('relay freezes server settings, filters provider secrets, stops blocked accounts and closes both sockets',async()=>{
 const f=await fixture();
 const upstream=new Socket(),server=new Socket(),client=new Socket();let authorization;
 const request=new Request('https://example.test/api/openai/realtime?language=en&mode=fast',{headers:{Cookie:f.cookie,Upgrade:'websocket',Origin:'https://example.test'}});
 const result=await realtimeRelay(request,f.env,async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/realtime?intent=transcription');authorization=init.headers.Authorization;return {webSocket:upstream};},{pairFactory:()=>({0:client,1:server}),upgrade:socket=>({status:101,webSocket:socket})});
 assert.equal(result.status,101);assert.equal(authorization,'Bearer '+f.env.OPENAI_API_KEY);
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const malicious={type:'session.update',session:{type:'realtime',audio:{input:{transcription:{model:'gpt-transcribe',languages:['en']},format:{type:'audio/pcmu'},turn_detection:{type:'server_vad'}}},tools:[{type:'function',name:'arbitrary'}]}};
 server.fire('message',malicious);await tick();assert.equal(upstream.sent[0].session.type,'transcription');assert.equal(upstream.sent[0].session.audio.input.format.rate,24000);assert.equal(upstream.sent[0].session.tools,undefined);
 upstream.fire('message',{type:'session.updated',session:{client_secret:f.env.OPENAI_API_KEY}});await tick();assert.deepEqual(server.sent[0],{type:'session.updated'});
 server.fire('message',{type:'connection.ping'});await tick();assert.deepEqual(server.sent.at(-1),{type:'connection.pong'});assert.equal(upstream.sent.length,1,'heartbeat must never call or bill the provider');
 await f.admin('/api/admin/costs/restrict',{accountId:f.account.id,until:Date.now()+60000,expectedUntil:0,reason:'manual block during recording'});
 server.fire('message',{type:'input_audio_buffer.append',audio:Buffer.alloc(4800).toString('base64')});server.fire('message',{type:'input_audio_buffer.commit'});
 for(let i=0;i<10&&server.readyState!==3;i++)await tick();assert.equal(upstream.sent.length,1);assert.equal(server.readyState,3);assert.equal(upstream.readyState,3);
 for(let i=0;i<10&&f.sql.prepare('SELECT lease_id FROM service_accounts').get().lease_id;i++)await tick();assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts').get().lease_id,null);
 assert.throws(()=>safeSession({session:{audio:{input:{transcription:{model:'expensive-untrusted-model'}}}}},'x','fast'),e=>e.status===400);
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(check){
 const deadline=performance.now()+3000;
 while(!check()){assert.ok(performance.now()<deadline,'timed out waiting for the relay');await tick();}
}
async function openRecording(t,f){
 const source=new Socket(),server=new Socket(),client=new Socket(),cleanup=[];
 const request=new Request('https://example.test/api/openai/realtime',{headers:{Cookie:f.cookie,Upgrade:'websocket',Origin:'https://example.test'}});
 await realtimeRelay(request,f.env,async()=>({webSocket:source}),{pairFactory:()=>[client,server],upgrade:()=>({status:101}),waitUntil:task=>cleanup.push(task)});
 t.after(async()=>{server.close();await Promise.all(cleanup);});
 server.fire('message',{type:'session.update',session:{audio:{input:{transcription:{model:'gpt-transcribe',languages:['en']}}}}});
 await waitFor(()=>source.sent.length>0);
 return {source,server,cleanup};
}
test('a 17-minute classroom drains delayed microphone frames in order and keeps translating',async t=>{
 const f=await fixture();
 let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
 const {source,server}=await openRecording(t,f);
 const frame={type:'input_audio_buffer.append',audio:Buffer.alloc(4800).toString('base64')};
 const turn=()=>{for(let i=0;i<80;i++){now+=100;t.mock.timers.tick(100);server.fire('message',frame);}server.fire('message',{type:'input_audio_buffer.commit'});};
 const complete=id=>{
  source.fire('message',{type:'input_audio_buffer.committed',item_id:id});
  source.fire('message',{type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:'Test sentence.'});
 };
 const received=id=>server.sent.some(event=>event.item_id===id&&event.audioProof);
 for(let i=0;i<125;i++){
  source.sent.length=0;turn();await waitFor(()=>source.sent.at(-1)?.type==='input_audio_buffer.commit');
  const id='turn-'+i;complete(id);await waitFor(()=>received(id));
 }
 // Delay a real reservation while another 24 seconds of the original client's
 // 100 ms packets arrive. No audio may reach the provider before admission.
 const batch=f.env.DB.batch.bind(f.env.DB);let hold=true,release;
 t.mock.method(f.env.DB,'batch',async items=>{
  if(hold){hold=false;await new Promise(resolve=>{release=resolve;});}
  return batch(items);
 });
 source.sent.length=0;
 // Enter the reservation before advancing the clock over the next lease check.
 server.fire('message',frame);server.fire('message',{type:'input_audio_buffer.commit'});
 await waitFor(()=>release);
 try{turn();turn();turn();assert.equal(source.sent.length,0);}finally{release();}
 const commits=()=>source.sent.filter(event=>event.type==='input_audio_buffer.commit').length;
 await waitFor(()=>commits()===3);complete('delayed-0');await waitFor(()=>commits()===4);
 for(let i=1;i<4;i++)complete('delayed-'+i);
 await waitFor(()=>received('delayed-3'));
 assert.equal(source.sent.filter(event=>event.type===frame.type).length,241);
 assert.equal(f.sql.prepare('SELECT audio_used FROM plan_balances').get().audio_used,1024100);
 assert.equal(f.sql.prepare('SELECT restricted_until FROM service_accounts').get().restricted_until,0);
 assert.equal(server.readyState,1);
 const response=await handle(f.request,async()=>Response.json({output:[{content:[{type:'output_text',text:'这是对的。'}]}]}),f.env);
 assert.equal(response.status,200);assert.match(await response.text(),/这是对的/);
});
test('a full connection queue requests reconnection and releases the lease without restricting the account',async t=>{
 const f=await fixture(),{source,server,cleanup}=await openRecording(t,f);
 // A burst of normal 100 ms packets may arrive together after a network stall.
 const frame={type:'input_audio_buffer.append',audio:Buffer.alloc(4800).toString('base64')};
 for(let i=0;i<550;i++)server.fire('message',frame);
 await Promise.all(cleanup);
 assert.equal(server.sent.at(-1).error.retryable,true);assert.equal(source.readyState,3);
 assert.equal(f.sql.prepare('SELECT restricted_until FROM service_accounts').get().restricted_until,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM security_audit WHERE action=?').get('service_abuse_restriction').n,0);
 assert.deepEqual(await (await f.api('/api/openai/status')).json(),{available:true});
});
test('invalid frame sizes restrict once and the translation and recording errors carry the same recovery time',async t=>{
 const f=await fixture(),{server,cleanup}=await openRecording(t,f);
 for(let i=0;i<3;i++)server.fire('message',' '.repeat(110001));
 await Promise.all(cleanup);
 const {restricted_until:until}=f.sql.prepare('SELECT restricted_until FROM service_accounts').get();
 assert.ok(until>Date.now());assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM security_audit WHERE action=?').get('service_abuse_restriction').n,1);
 assert.equal(server.sent.at(-1).error.retryable,false);
 const response=await handle(f.request,()=>assert.fail('a restricted request must stop locally'),f.env);
 assert.equal(response.status,403);
 const {error}=await response.json();assert.equal(error.code,'account_restricted');assert.equal(error.retryAt,until);
 assert.deepEqual(await (await f.api('/api/openai/status')).json(),{available:false,...error});
 t.mock.method(Date,'now',()=>until);assert.deepEqual(await (await f.api('/api/openai/status')).json(),{available:true});
});
test('automatic reconnect can replace its own lease without allowing two audio senders or interrupting another browser',async()=>{
 const f=await fixture(),owner=crypto.randomUUID();const request=new Request('https://example.test/api/openai/realtime?owner='+owner,{headers:{Cookie:f.cookie}});
 const old=await acquireLease(request,f.env),fresh=await acquireLease(request,f.env);assert.notEqual(old.id,fresh.id);
 await assert.rejects(()=>reserve(request,f.env,{kind:'audio',audioMs:1000,lease:old}),e=>e.status===402);
 const row=await reserve(request,f.env,{kind:'audio',audioMs:1000,lease:fresh});assert.ok(row);
 await releaseLease(f.env,old);assert.equal(f.sql.prepare('SELECT lease_id FROM service_accounts').get().lease_id,fresh.id);
 await assert.rejects(()=>acquireLease(new Request('https://example.test/api/openai/realtime?owner='+crypto.randomUUID(),{headers:{Cookie:f.cookie}}),f.env),e=>e.status===409);
 await settle(f.env,row,{});await releaseLease(f.env,fresh);
});
test('admin settings reject stale revisions, invalid budgets, and ordinary accounts without changing existing memberships',async()=>{
 const f=await fixture(),before=f.sql.prepare('SELECT * FROM account_memberships').all();await f.configure({warningCents:4000,hardCents:5000});
 const bad=await f.admin('/api/admin/costs/settings',{warningCents:9000,hardCents:100,paused:false,expectedRevision:1,reason:'invalid'});assert.equal(bad.status,400);
 const stale=await f.admin('/api/admin/costs/settings',{warningCents:null,hardCents:null,paused:false,expectedRevision:0,reason:'stale'});assert.equal(stale.status,409);
 assert.deepEqual(f.sql.prepare('SELECT * FROM account_memberships').all(),before);
});

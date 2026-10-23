import test from 'node:test';
import assert from 'node:assert/strict';
import {openTranscription,checkRealtimeConnection} from '../src/realtime-connection.js';
import {handle} from '../src/worker.js';
import {environment} from './server-fixture.mjs';
import {memberHandle} from './access-fixture.mjs';
import {req} from './server-fixture.mjs';
import {TRANSLATION_INSTRUCTIONS} from '../src/translation-prompt.js';

test('successful WebSocket upgrade cancels the handshake deadline and stays alive beyond 20 seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,closed=false;
 await openTranscription({OPENAI_API_KEY:'test-secret'},async(url,init)=>{signal=init.signal;signal.addEventListener('abort',()=>{closed=true;});return {webSocket:{accept(){}}};});
 t.mock.timers.tick(65000);assert.equal(signal.aborted,false);assert.equal(closed,false);
});
test('an actual handshake stall still aborts after 20 seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let aborted=false;
 const pending=openTranscription({OPENAI_API_KEY:'test-secret'},async(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Handshake timed out'));})));
 const result=assert.rejects(pending,e=>e.diagnostic.code==='upstream_transport');
 t.mock.timers.tick(20000);await result;assert.equal(aborted,true);
});

test('no-audio diagnostic closes a successfully upgraded upstream without sending audio',async()=>{
 let accepted=false,closed=false;const listeners={};
 const result=await checkRealtimeConnection({OPENAI_API_KEY:'test-secret'},async(url,init)=>{
  if(!['manual','follow'].includes(init.redirect))throw new TypeError('Invalid redirect value');
  assert.equal(init.redirect,'manual');
  return {webSocket:{accept(){accepted=true;},close(){closed=true;},addEventListener(type,handler){listeners[type]=handler;},send(raw){const data=JSON.parse(raw);assert.equal(data.type,'session.update');assert.equal(data.session.type,'transcription');listeners.message({data:JSON.stringify({type:'session.updated'})});}}};
 });
 assert.deepEqual(result,{available:true,configured:true});assert.ok(accepted&&closed);
});
test('failed handshake preserves safe error classification and redacts transport secrets',async()=>{
 const env={OPENAI_API_KEY:'test-secret'};
 await assert.rejects(()=>openTranscription(env,async()=>Response.json({error:{code:'insufficient_quota',message:'test-secret'}},{status:429})),e=>e.diagnostic.code==='insufficient_quota'&&!e.message.includes(env.OPENAI_API_KEY));
 const result=await checkRealtimeConnection(env,async()=>{throw new TypeError('Failed test-secret sk-anothersecret');});
 assert.equal(result.error.code,'upstream_transport');assert.equal(JSON.stringify(result).includes('test-secret'),false);assert.equal(JSON.stringify(result).includes('sk-anothersecret'),false);
});
test('redirects from the realtime API are rejected without a second request',async()=>{
 let calls=0;const result=await checkRealtimeConnection({OPENAI_API_KEY:'test-secret'},async(url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://untrusted.example'}});});
 assert.equal(result.available,false);assert.equal(result.error.status,307);assert.equal(calls,1);
});
test('text translation works with Workers redirect modes and refuses provider redirects',async()=>{
 const request=()=>req('/api/openai/responses',{input:'Hello',instructions:TRANSLATION_INSTRUCTIONS});
 const result=await memberHandle(request(),async(url,init)=>{
  if(!['follow','manual'].includes(init.redirect))throw new TypeError('Invalid redirect value');
  assert.equal(init.redirect,'manual');return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'你好'}]}]});
 });
 assert.equal(result.status,200);
 let calls=0;const redirect=await memberHandle(request(),async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}});});
 assert.equal(redirect.status,503);assert.equal(calls,1);assert.match((await redirect.json()).error.message,/异常跳转/);
});
test('anonymous visitors cannot trigger the administrator connection check',async()=>{
 const {env}=environment();env.MEMBER_ADMIN_TOKEN_SHA256='ab'.repeat(32);
 let called=false;const result=await handle(new Request('https://example.test/api/admin/realtime/check',{method:'POST'}),()=>{called=true;},env);
 assert.equal(result.status,401);assert.equal(called,false);
});

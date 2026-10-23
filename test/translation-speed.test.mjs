import {TRANSLATION_INSTRUCTIONS} from '../src/translation-prompt.js';
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectTranslation} from '../src/text-stream.js';
import {translationStream} from '../src/translation-proxy.js';
import {generateText} from '../src/core.js';
import {BrowserLive} from '../src/live.js';
import {setAccount,saveSession,getSession,getMaterial,saveMaterial,removeMaterial,sessionSyncPending,clearLocalAccount} from '../src/storage.js';
import {activeMaterials} from '../src/materials.js';
import {activateClientMembership} from './access-fixture.mjs';
import {handle} from '../src/worker.js';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
const tick=()=>new Promise(r=>setTimeout(r,5));
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await tick();}throw Error('Timed out');};
const encode=e=>new TextEncoder().encode('data: '+JSON.stringify(e)+'\r\n\r\n');
function channel(){let controller;return {body:new ReadableStream({start(c){controller=c;}}),send:e=>controller.enqueue(encode(e)),end:()=>controller.close()};}
const session=id=>({id,title:'课堂',createdAt:new Date().toISOString(),segments:[],materials:[],warnings:[],status:'recording',summary:'',sourceLanguage:'en'});
test('SSE shows Chinese before completion, survives byte-split UTF8, and never exposes provider errors',async()=>{
 const c=channel(),seen=[];let finished=false;
 const promise=collectTranslation(translationStream(c.body),s=>seen.push(s)).then(s=>{finished=true;return s;});
 c.send({type:'response.output_text.delta',delta:'机会'});await until(()=>seen.length);assert.equal(seen[0],'机会');assert.equal(finished,false);
 c.send({type:'response.output_text.delta',delta:'成本'});c.send({type:'response.completed',response:{status:'completed',output:[]}});c.end();assert.equal(await promise,'机会成本');
 const bytes=encode({type:'completed',text:'中文🏫'}),split=new ReadableStream({start(controller){for(const b of bytes)controller.enqueue(Uint8Array.of(b));controller.close();}});
 assert.equal(await collectTranslation(split,()=>{}),'中文🏫');
 const failure=channel();failure.send({type:'error',error:{message:'sk-test-never-expose'}});failure.end();
 await assert.rejects(()=>collectTranslation(translationStream(failure.body),()=>{}),e=>!e.message.includes('sk-test')&&/暂时不可用/.test(e.message));
});
test('truncated stream retains partial text, fails visibly, and does not issue duplicate paid requests',async()=>{
 let calls=0,last='';
 await assert.rejects(()=>generateText('member','translate','source',{onDelta:s=>last=s,fetcher:async()=>{calls++;const c=channel();c.send({type:'delta',text:'部分译文'});c.end();return new Response(c.body,{headers:{'Content-Type':'text/event-stream'}});}}),/不完整/);
 assert.equal(last,'部分译文');assert.equal(calls,1);
});
test('Worker streaming path retains membership checks, forwards streaming, and filters secret metadata',async()=>{
 const {env}=environment();const who=await createVerifiedAccountSession(env,{provider:'email',subject:'stream@test.invalid',label:'test'}),cookie=who.cookie.split(';')[0];
 await handle(req('/api/member/login',{code:env.MEMBER_CODE},cookie),()=>{},env);
 const body={input:'lesson',instructions:TRANSLATION_INSTRUCTIONS,stream:true};let count=0;
 const upstream=async(url,options)=>{count++;assert.equal(JSON.parse(options.body).stream,true);const c=channel();c.send({type:'response.created',secret:env.OPENAI_API_KEY});c.send({type:'response.output_text.delta',delta:'你好'});c.send({type:'response.completed',response:{status:'completed'}});c.end();return new Response(c.body,{headers:{'Content-Type':'text/event-stream'}});};
 assert.equal((await handle(req('/api/openai/responses',body,'',{'X-Access-Mode':'member'}),upstream,env)).status,401);
 const response=await handle(req('/api/openai/responses',body,cookie,{'X-Access-Mode':'member'}),upstream,env);
 assert.match(response.headers.get('Content-Type'),/event-stream/);const text=await response.text();assert.match(text,/你好/);assert.ok(!text.includes(env.OPENAI_API_KEY));assert.equal(count,1);
});
test('slow cloud writes do not block local saves; coalesced latest snapshot keeps revisions ordered',async()=>{
 const original=globalThis.fetch,owner='speed-save';let release,requests=[];
 setAccount({id:owner});globalThis.fetch=async(path,init)=>{const body=JSON.parse(init.body);requests.push(body);if(requests.length===1)await new Promise(r=>release=r);return Response.json({revision:body.revision+1});};
 try{
  const s=session('save');await saveSession(s,{background:true});await until(()=>release);
  s.summary='latest';await saveSession(s,{background:true});assert.equal((await getSession(s.id)).summary,'latest');assert.equal(await sessionSyncPending(s.id),true);
  release();await saveSession(s);assert.equal(await sessionSyncPending(s.id),false);assert.equal(requests.at(-1).session.summary,'latest');assert.deepEqual(requests.map(x=>x.revision),requests.map((_,i)=>i));
 }finally{await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});
test('failed background save retries and preserves the local record',async()=>{
 const original=globalThis.fetch;let requests=0;setAccount({id:'retry'});
 globalThis.fetch=async()=>++requests===1?Response.json({error:{message:'offline'}},{status:503}):Response.json({revision:1});
 try{await saveSession(session('retry-class'),{background:true});await until(()=>requests===1);assert.equal((await getSession('retry-class')).id,'retry-class');await until(async()=>!(await sessionSyncPending('retry-class'))||requests>1).catch(()=>{});
 // Actual browser-style retry timer (5 s), no new save call required.
 await new Promise(r=>setTimeout(r,5100));assert.equal(requests,2);assert.equal(await sessionSyncPending('retry-class'),false);
 }finally{await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});
test('PPT cache deduplicates concurrent reads; disabled/deleted/updated/reopened and different owners stay isolated',async()=>{
 const original=globalThis.fetch;let reads=0,text='version 1';setAccount({id:'materials-a'});
 globalThis.fetch=async(path,init={})=>{if(init.method==='PUT'||init.method==='DELETE')return Response.json({ok:true});reads++;if(!path.includes('/materials/'))return Response.json({session:session('course'),revision:0});return Response.json({id:'m',name:'slides.pptx',pages:[{label:'1',text}]});};
 try{
  await Promise.all([getMaterial('course','m'),getMaterial('course','m')]);assert.equal(reads,1);
  const copy=await getMaterial('course','m');copy.pages[0].text='mutated';assert.equal((await getMaterial('course','m')).pages[0].text,'version 1');
  assert.deepEqual(await activeMaterials({id:'course',materials:[{id:'m',enabled:false}]}),[]);
  await saveMaterial('course',{id:'m'});text='version 2';assert.equal((await getMaterial('course','m')).pages[0].text,text);assert.equal(reads,2);
  await getMaterial('another-course','m');assert.equal(reads,3);
  await removeMaterial('course','m');await getMaterial('course','m');assert.equal(reads,4);
  await getSession('course');await getMaterial('course','m');assert.equal(reads,6);
  setAccount({id:'materials-b'});await getMaterial('course','m');assert.equal(reads,7);
 }finally{setAccount(null);globalThis.fetch=original;}
});
test('live translation streams and completes before a delayed cloud save; next translation starts immediately',async()=>{
 await activateClientMembership();const original=globalThis.fetch,live=new BrowserLive(),events=[];let release,calls=0,first;
 setAccount({id:'live-speed'});
 globalThis.fetch=async(path,init)=>{if(path==='/api/openai/responses'){calls++;const c=channel();if(calls===1){first=c;c.send({type:'delta',text:'老师'});}else {c.send({type:'completed',text:'下一个片段。'});c.end();}return new Response(c.body,{headers:{'Content-Type':'text/event-stream'}});}const body=JSON.parse(init.body);if(!release)await new Promise(r=>release=r);return Response.json({revision:body.revision+1});};
 live.session=session('live');live.onmessage=e=>events.push(JSON.parse(e.data));
 try{
  const a={id:'a',offset:0,source:'The teacher explains this topic.',translation:''},b={id:'b',offset:1000,source:'The next sentence is here.',translation:''};live.session.segments.push(a,b);live.enqueueTranslation(a);live.enqueueTranslation(b);
  await until(()=>events.some(e=>e.type==='translation'));assert.equal(a.translation,'老师');assert.equal(a.state,'translating');
  first.send({type:'completed',text:'老师在讲课。'});first.end();await live.queue;
  assert.equal(calls,2);assert.equal(b.state,'translated');assert.ok(events.some(e=>e.type==='session'&&e.session.segments[0].state==='translated'));
  assert.equal(release,undefined);const flush=saveSession(live.session);await until(()=>release);release();await flush;
 }finally{live.finalizing=true;live.close();await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});

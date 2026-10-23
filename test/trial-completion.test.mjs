import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
import {acquireLease,reserve,settle,releaseLease} from '../src/service-ledger.js';
import {issueAudioProof} from '../src/audio-proof.js';
import {refreshAccess,accessConfig} from '../src/access.js';
import {localApi} from '../src/local-api.js';
import {BrowserLive} from '../src/live.js';
import {setAccount,getSession,saveSession,clearLocalAccount} from '../src/storage.js';

test('ending a trial classroom finishes queued translation, saves and reopens without generating a summary',async()=>{
 const {env}=environment(),objects=new Map();const batch=env.DB.batch.bind(env.DB);let previous=Promise.resolve();env.DB.batch=items=>{const run=previous.then(()=>batch(items));previous=run.catch(()=>{});return run;};env.BUCKET={put:async(key,text)=>objects.set(key,text),get:async key=>objects.has(key)?{json:async()=>JSON.parse(objects.get(key))}:null,delete:async key=>objects.delete(key)};
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:crypto.randomUUID()+'@test.example',label:'trial-completion'}),cookie=account.cookie.split(';')[0],original=globalThis.fetch;
 let summaryRequests=0,providerRequests=0;
 globalThis.fetch=async(path,init={})=>{
  if(path==='/api/service/summary')summaryRequests++;
  const request=new Request('https://example.test'+path,{...init,headers:{...init.headers,Cookie:cookie,Origin:'https://example.test'}});
  return handle(request,async()=>{providerRequests++;return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'机会成本是最佳替代选择的价值。'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:100,output_tokens:20}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});},env);
 };
 const live=new BrowserLive();
 try{
  setAccount(account.user);await refreshAccess();assert.equal(accessConfig().tier,'trial');
  const session=await localApi('/api/sessions',{method:'POST',body:JSON.stringify({title:'免费翻译课堂'})});
  const source='Opportunity cost is the next best alternative.',audioRequest=req('/',{},cookie),lease=await acquireLease(audioRequest,env);
  const audioRow=await reserve(audioRequest,env,{kind:'audio',audioMs:1000,lease});await settle(env,audioRow,{success:true});
  const audioProof=await issueAudioProof(env,account.user.id,audioRow.id,source);await releaseLease(env,lease);
  live.session=session;live.base=0;live.started=Date.now();live.paused=false;live.closing=true;const events=[];let finished;const finishedPromise=new Promise(resolve=>finished=resolve);live.onmessage=e=>{const event=JSON.parse(e.data);events.push(event);if(event.type==='finished')finished();};
  await live.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'last',transcript:source,audioProof});
  await live.finalize();await finishedPromise;
  assert.equal(live.closed,true);assert.equal(session.status,'completed');assert.equal(session.summary,'');assert.equal(session.summaryError,undefined);
  assert.equal(summaryRequests,0);assert.equal(providerRequests,1);assert.ok(events.some(e=>e.type==='status'&&e.message==='正在完成翻译并保存课堂…'));
  assert.equal(events.at(-1).type,'finished');assert.ok(!session.warnings.some(w=>w.includes('生成总结')));
  await saveSession(session);await clearLocalAccount();
  const reopened=await getSession(session.id);assert.equal(reopened.status,'completed');assert.equal(reopened.segments[0].source,'Opportunity cost is the next best alternative.');assert.equal(reopened.segments[0].translation,'机会成本是最佳替代选择的价值。');assert.equal(reopened.summaryError,undefined);assert.equal(reopened.segments[0].audioProof,audioProof);assert.equal(reopened.segments[0].sourceParts[0].audioProof,audioProof);assert.equal(summaryRequests,0);
  // An explicit summary request still reaches the server and explains membership.
  await assert.rejects(()=>localApi('/api/sessions/'+session.id+'/summary',{method:'POST',body:'{}'}),/免费时长仅含翻译.*开通会员/);
  assert.equal(summaryRequests,1);assert.equal(providerRequests,1);
 }finally{live.close();await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'buffer';
import {LANGUAGES,transcriptionConfig} from '../src/languages.js';
import {translationMode} from '../src/models.js';
import {AudioTurns} from '../src/core.js';
import {BrowserLive} from '../src/live.js';
import {localApi} from '../src/local-api.js';
import {setAccount,getTranslationModePreference,saveTranslationModePreference,saveSession} from '../src/storage.js';
import {memberHandle,activateClientMembership} from './access-fixture.mjs';

test('both modes have matching server and client settings in every language, with the old default unchanged',async()=>{
 for(const {code} of LANGUAGES){
  const original={model:'gpt-transcribe',...(code==='auto'?{}:{languages:[code]}),prompt:'A classroom lecture. Transcribe speech in its original language without translating it. Course: Test'};
  assert.deepEqual(transcriptionConfig(code,'Test'),original);
  assert.deepEqual(transcriptionConfig(code,'Test','accurate'),original);
  for(const mode of ['accurate','fast']){
   let payload;
   const response=await memberHandle(new Request('https://example.test/api/openai/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceLanguage:code,title:'Test',translationMode:mode,model:'untrusted-model'})}),async(url,init)=>{payload=JSON.parse(init.body);return Response.json({value:'temporary'});});
   assert.equal(response.status,200);assert.deepEqual(payload.session.audio.input.transcription,transcriptionConfig(code,'Test',mode));
   assert.deepEqual(payload.session.audio.input.transcription,original);
  }
 }
 for(const mode of ['invalid','__proto__',{},false]){
  const response=await memberHandle(new Request('https://example.test/api/openai/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({translationMode:mode})}),()=>{throw Error('Must not spend quota for invalid mode');});
  assert.equal(response.status,400);
 }
});

test('mode preference persists per account and defaults to accurate for new users',async()=>{
 try{
  setAccount({id:'mode-a'});assert.equal(await getTranslationModePreference(),'accurate');await saveTranslationModePreference('fast');
  setAccount({id:'mode-b'});assert.equal(await getTranslationModePreference(),'accurate');
  setAccount({id:'mode-a'});assert.equal(await getTranslationModePreference(),'fast');await assert.rejects(()=>saveTranslationModePreference('invalid'));assert.equal(await getTranslationModePreference(),'fast');
 }finally{setAccount(null);}
});

test('start and later resume use saved choice; reconnection keeps the active mode',async t=>{
 await activateClientMembership();await saveTranslationModePreference('fast');
 const s=await localApi('/api/sessions',{method:'POST',body:JSON.stringify({title:'Modes'})});assert.equal(s.translationMode,'fast');
 const requests=[],sockets=[];
 class Socket{constructor(){this.readyState=1;this.sent=[];sockets.push(this);}send(data){this.sent.push(JSON.parse(data));}close(){this.readyState=3;}}
 t.mock.property(globalThis,'WebSocket',Socket);
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'/api/openai/token');requests.push(JSON.parse(init.body));return Response.json({value:'temporary'});});
 const live=new BrowserLive();let next;
 try{
  await live.command({type:'start',id:s.id});sockets[0].onopen();
  assert.equal(requests[0].translationMode,'fast');assert.equal(sockets[0].sent[0].session.audio.input.transcription.model,'gpt-transcribe');assert.equal(live.merger.maxWait,3000);
  await saveTranslationModePreference('accurate');await live.connect();sockets[1].onopen();assert.equal(requests[1].translationMode,'fast');
  live.finalizing=true;live.close();await saveSession(live.session);
  next=new BrowserLive();await next.command({type:'start',id:s.id});sockets[2].onopen();
  assert.equal(requests[2].translationMode,'accurate');assert.equal(sockets[2].sent[0].session.audio.input.transcription.model,'gpt-transcribe');assert.equal(next.merger.maxWait,6000);
 }finally{live.finalizing=true;live.close();if(next){next.finalizing=true;next.close();}await saveTranslationModePreference('accurate');}
});

test('fast commits speech sooner, accurate preserves existing audio boundaries, neither loses audio',()=>{
 const frame=Buffer.alloc(4800);for(let i=0;i<frame.length;i+=2)frame.writeInt16LE(4000,i);
 for(const [mode,frames] of [['accurate',80],['fast',60]]){
  let commits=0,bytes=0;const turns=new AudioTurns(b=>bytes+=b.length,()=>commits++,translationMode(mode));
  for(let i=0;i<frames-1;i++)turns.push(frame);assert.equal(commits,0);turns.push(frame);assert.equal(commits,1);assert.equal(bytes,frames*frame.length);
 }
});

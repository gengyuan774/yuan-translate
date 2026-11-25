import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {resumeAudioContext} from '../src/capture-health.js';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('async function interruptedCapture('),source.indexOf('function watchMicrophone('))+
 source.slice(source.indexOf('async function pauseRecording('),source.indexOf('async function finish('))+
 source.slice(source.indexOf('async function restoreRecording('),source.indexOf('initRecordingLifecycle({'));
function fixture(overrides={}){
 const commands=[],messages=[],elements=new Map(),track={readyState:'live',muted:false,enabled:true};let acquisitions=0;
 const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
 const context=vm.createContext({$,mode:'recording',pauseTask:null,restoringAudio:false,captureNeedsReconnect:false,captureResumePending:false,resumeAfterSystemInterruption:false,
  ws:{readyState:1,verifyConnection(){commands.push('verify');},warn:m=>messages.push(m)},WebSocket:{OPEN:1},
  stream:{getAudioTracks:()=>[track]},context:{state:'running',createMediaStreamSource:()=>({connect(){}})},micSource:{disconnect(){}},capture:{},
  startedAt:Date.now(),elapsed:0,tick:null,clearInterval,Date,document:{visibilityState:'visible'},navigator:{},
  send:message=>commands.push(message.type),flush:async()=>{},resumeAudioContext:context=>resumeAudioContext(context,{timeoutMs:15}),
  acquireMicrophone:async()=>{acquisitions++;track.readyState='live';},captureHealth:{returned(){},check(){}},notice:m=>messages.push(m),
  controls:next=>context.mode=next,releaseAudio:async()=>{},begin:async()=>commands.push('begin'),closeFailedConnection:()=>{},...overrides});
 vm.runInContext(functions,context);return {context,commands,messages,track,acquisitions:()=>acquisitions,run:()=>vm.runInContext('restoreRecording()',context)};
}
test('returning to a manually paused class does not resume recording',async()=>{
 const f=fixture({mode:'paused'});await f.run();assert.deepEqual(f.commands,[]);assert.equal(f.context.mode,'paused');
});
test('manual pause clears an old recovery message and stays paused on return',async()=>{
 const f=fixture();f.messages.push('连接已恢复，继续记录这节课。');await vm.runInContext('pauseRecording()',f.context);
 assert.equal(f.context.mode,'paused');assert.equal(f.messages.at(-1),'');await f.run();assert.equal(f.context.mode,'paused');assert.deepEqual(f.commands,['pause']);
});
test('system-muted microphone stays paused until the OS un-mutes, then the same class resumes once',async()=>{
 const f=fixture({mode:'paused',resumeAfterSystemInterruption:true});f.track.muted=true;await f.run();assert.deepEqual(f.commands,[]);assert.equal(f.acquisitions(),0);
 f.track.muted=false;await f.run();assert.deepEqual(f.commands,['resume']);assert.equal(f.context.mode,'connecting');assert.equal(f.acquisitions(),0);
});
test('an ended track discovered on return is replaced and resumed without making a new class',async()=>{
 const f=fixture();f.track.readyState='ended';await f.run();assert.equal(f.acquisitions(),1);assert.deepEqual(f.commands,['pause','resume']);assert.equal(f.context.mode,'connecting');
});
test('a stalled capture reopens the input and keeps the recording paused until the connection is ready',async()=>{
 const f=fixture({mode:'paused',resumeAfterSystemInterruption:true,captureNeedsReconnect:true});await f.run();assert.equal(f.acquisitions(),1);assert.deepEqual(f.commands,['resume']);assert.equal(f.context.mode,'connecting');
});
test('audio resume timeout returns to a retryable paused state instead of hanging in connecting',async()=>{
 const f=fixture({mode:'paused',resumeAfterSystemInterruption:true,context:{state:'interrupted',resume:()=>new Promise(()=>{})}});await f.run();assert.equal(f.context.mode,'paused');assert.deepEqual(f.commands,[]);assert.match(f.messages.at(-1),/继续录音/);assert.equal(f.context.restoringAudio,false);
});
test('a pending system pause cannot overwrite finish or resume after an explicit manual pause',async()=>{
 let resolve;const f=fixture({flush:()=>new Promise(r=>resolve=r)});const pending=vm.runInContext('pauseRecording(true)',f.context);
 f.context.mode='finishing';f.context.resumeAfterSystemInterruption=false;resolve();await pending;assert.equal(f.context.mode,'finishing');assert.deepEqual(f.commands,[]);
 const g=fixture({flush:()=>new Promise(r=>resolve=r)});const automatic=vm.runInContext('pauseRecording(true)',g.context),manual=vm.runInContext('pauseRecording()',g.context);resolve();await Promise.all([automatic,manual]);assert.equal(g.context.resumeAfterSystemInterruption,false);assert.deepEqual(g.commands,['pause']);
});
test('new subtitles cannot replace the recovered status with an old saved interruption warning',()=>{
 const statement=source.slice(source.indexOf(' const warnings=current.warnings'),source.indexOf('\n}\nasync function history('));
 for(const mode of ['recording','connecting','reconnecting','paused','finishing','ended']){
  const messages=[];vm.runInNewContext(statement,{mode,current:{warnings:['old interruption']},notice:text=>messages.push(text)});
  assert.equal(messages.length,mode==='ended'?1:0);
 }
});

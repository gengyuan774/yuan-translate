import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserLive,lastAudioEnd} from '../src/live.js';
import {TranscriptMerger} from '../src/transcript-merge.js';
import {AudioTurns} from '../src/core.js';
import {getSession,saveSession,setAccount} from '../src/storage.js';
import {activateClientMembership} from './access-fixture.mjs';
import {busy} from '../src/local-api.js';
test('continuing a paused class starts after the last full audio turn, not one second after its start',()=>{
 const segments=[{id:'a',offset:1000,durationMs:8000},{id:'b',offset:9000,durationMs:6000}];assert.equal(lastAudioEnd({segments}),15000);
 assert.equal(lastAudioEnd({segments:[]}),0);assert.equal(lastAudioEnd({segments:[{offset:17000}]}),17000);
});
test('merged fragments retain the duration of the final source part across saving and reconnecting',()=>{
 let saved;const merger=new TranscriptMerger({submit:row=>saved=structuredClone(row),remove(){},setTimer:()=>1,clearTimer(){}});
 merger.add({id:'a',source:'The next part of',sourceLanguage:'en',offset:1000,durationMs:8000});
 merger.add({id:'b',source:'the lecture explains opportunity cost and inflation.',sourceLanguage:'en',offset:9000,durationMs:7000});merger.flush();
 assert.equal(saved.sourceParts.length,2);assert.equal(lastAudioEnd({segments:[saved]}),16000);
});
test('a pause at 2399, 2400 or 2401 samples keeps exactly the committed PCM across resumes',()=>{
 for(const size of [2399,2400,2401]){
  const sent=[],turns=[];let pending=[];
  const vad=new AudioTurns(chunk=>{sent.push(chunk);pending.push(chunk);},()=>{turns.push(Buffer.concat(pending));pending=[];});
  const first=Buffer.alloc(size*2,0x33),second=Buffer.alloc(4800,0x55);
  vad.push(first.subarray(0,2048));vad.push(first.subarray(2048));vad.flush();
  assert.equal(Buffer.concat(sent).length,size<2400?0:first.length);
  vad.push(second);vad.flush();assert.deepEqual(turns,size<2400?[second]:[first,second]);
 }
});
test('64 seeded partitions of the same audio preserve bytes and turn order',()=>{
 let seed=20261120;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const recordings=[1600,2400,2401,17583,19,8991].map((n,i)=>Buffer.alloc(n*2,0x22+i));
 for(let trial=0;trial<64;trial++){
  const commits=[];let frames=[];const vad=new AudioTurns(b=>frames.push(b),()=>{commits.push(Buffer.concat(frames));frames=[];});
  for(const recording of recordings){
   let start=0;while(start<recording.length){const end=start+2*(1+next()%1600);vad.push(recording.subarray(start,end));start=end;}vad.flush();
  }
  assert.deepEqual(commits,recordings.filter(b=>b.length>=4800));assert.equal(frames.length,0);
 }
});
test('duplicate audio acknowledgements preserve the timestamp and language of the next turn',async()=>{
 const live=new BrowserLive();live.session={segments:[],sourceLanguage:'auto'};live.persist=async()=>{};
 live.meta=[{offset:1200,durationMs:500,sourceLanguage:'en'},{offset:4900,durationMs:800,sourceLanguage:'fr'}];
 for(const item_id of ['a','a','b'])await live.handle({type:'input_audio_buffer.committed',item_id});
 assert.deepEqual(live.session.segments.map(r=>[r.offset,r.durationMs,r.sourceLanguage]),[[1200,500,'en'],[4900,800,'fr']]);
});
test('a failed attempt to continue a saved classroom preserves the previous notes on disk',async()=>{
 setAccount(null);await activateClientMembership();
 const id=crypto.randomUUID(),summary='已经整理的课堂笔记';
 await saveSession({id,title:'已完成',summary,status:'completed',segments:[],materials:[],warnings:[]});
 const live=new BrowserLive();live.connect=async()=>{throw Error('offline');};
 try{await assert.rejects(live.command({type:'start',id}),/offline/);}finally{live.close();}
 await live.persist();const saved=await getSession(id);assert.equal(saved.summary,summary);assert.equal(saved.status,'completed');
});
test('only a new nonempty transcript marks the previous summary as needing an update',async()=>{
 const live=new BrowserLive();live.session={summary:'先前的笔记',segments:[],warnings:[]};live.persist=async()=>{};live.enqueueTranslation=()=>{};
 live.base=0;live.started=Date.now();live.finalizing=false;
 for(const [id,transcript] of [['silence',' '],['speech','The new lecture has begun.']]){
  await live.handle({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript});
  assert.equal(!!live.session.summaryStale,id==='speech');assert.equal(live.session.summary,'先前的笔记');
 }
 live.finalizing=true;live.close();
});
test('closing during the initial classroom read never starts a connection or leaves a busy class',async t=>{
 await activateClientMembership();const owner=crypto.randomUUID(),id=crypto.randomUUID(),entered=Promise.withResolvers(),reply=Promise.withResolvers();
 setAccount({id:owner});t.after(()=>{setAccount(null);busy.delete(id);});
 t.mock.method(globalThis,'fetch',async()=>{entered.resolve();await reply.promise;return Response.json({session:{id,status:'completed',segments:[]},revision:1});});
 const live=new BrowserLive();let connections=0;live.connect=async()=>{connections++;};
 const start=live.command({type:'start',id});await entered.promise;live.close();reply.resolve();await start;
 assert.equal(connections,0);assert.equal(busy.has(id),false);
});

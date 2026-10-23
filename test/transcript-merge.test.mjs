import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioTurns} from '../src/core.js';
import {needsContinuation,TranscriptMerger} from '../src/transcript-merge.js';
import {BrowserLive} from '../src/live.js';
import {translationMode} from '../src/models.js';
import {activateClientMembership} from './access-fixture.mjs';
import {saveSession,getSession} from '../src/storage.js';

const audio=(ms,amplitude=0)=>{const b=Buffer.alloc(ms*24*2);for(let i=0;i<b.length;i+=2)b.writeInt16LE(amplitude,i);return b;};
test('breathing pauses under 1.2 seconds stay in one turn, with an 8-second safety cap',()=>{
 let commits=0;const turns=new AudioTurns(()=>{},()=>commits++);
 turns.push(audio(200,1000));turns.push(audio(700));assert.equal(commits,0);
 turns.push(audio(200,1000));turns.push(audio(1199));assert.equal(commits,0);
 turns.push(audio(1));assert.equal(commits,1);turns.flush();assert.equal(commits,1);
 for(let i=0;i<80;i++)turns.push(audio(100,1000));assert.equal(commits,2);
 turns.push(audio(200,1000));turns.flush();assert.equal(commits,3);
});
test('fragment cues override recognizer periods, without delaying every full sentence',()=>{
 for(const source of ['The main reason.','why this happens.','We need to account for.','This is because.','Although demand has increased.','这主要是因为。','包括。'])assert.equal(needsContinuation(source),true,source);
 for(const source of ['The main reason. why this happens. is the increase in demand.','Demand increases because more people want to buy goods.','Why does this happen?','Thank you.','需求增加会使价格上涨。'])assert.equal(needsContinuation(source),false,source);
});
function mergerFixture(){
 let now=0,next=0;const timers=new Map(),submitted=[],removed=[];
 const merger=new TranscriptMerger({submit:row=>submitted.push(structuredClone(row)),remove:row=>removed.push(row.id),setTimer:(fn,ms)=>{timers.set(++next,{fn,at:now+ms});return next;},clearTimer:id=>timers.delete(id)});
 return {merger,submitted,removed,advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}},timers};
}
const row=(id,source,offset=0,sourceLanguage='en')=>({id,source,offset,sourceLanguage,state:'assembling',translation:''});
test('fast mode keeps a breathing pause and joins a delayed clause before translating',()=>{
 const settings=translationMode('fast');let commits=0;
 const turns=new AudioTurns(()=>{},()=>commits++,settings);
 turns.push(audio(200,1000));turns.push(audio(700));assert.equal(commits,0);
 turns.push(audio(200,1000));turns.push(audio(900));assert.equal(commits,1);
 const f=mergerFixture();f.merger.maxWait=settings.mergeWait;
 f.merger.add(row('a','The main reason.',0));f.advance(2000);assert.equal(f.submitted.length,0);
 f.merger.add(row('b','is the increase in demand.',2000));
 assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].source,'The main reason. is the increase in demand.');
 assert.equal(f.submitted[0].sourceParts.length,2);assert.equal(f.timers.size,0);
 f.merger.add(row('c','Because.',4000));f.advance(2999);assert.equal(f.submitted.length,1);
 f.advance(1);assert.equal(f.submitted.length,2);
});
test('default timers never receive the merger as the native browser receiver',t=>{
 const scheduled=new Map(),submitted=[];let id=0;
 t.mock.method(globalThis,'setTimeout',function(callback,ms){assert.ok(this===undefined||this===globalThis,'invalid native timer receiver');scheduled.set(++id,{callback,ms});return id;});
 t.mock.method(globalThis,'clearTimeout',function(timer){assert.ok(this===undefined||this===globalThis,'invalid native timer receiver');scheduled.delete(timer);});
 const merger=new TranscriptMerger({submit:r=>submitted.push(r.source),remove:()=>{}});
 merger.add(row('complete','The teacher explains the main topic in detail.'));
 assert.equal(submitted.length,1);assert.equal(scheduled.size,0);
 merger.add(row('fragment','Because.'));assert.equal(submitted.length,1);
 assert.equal([...scheduled.values()][0].ms,6000);[...scheduled.values()][0].callback();
 assert.equal(submitted.length,2);assert.equal(scheduled.size,0);
});
test('three fragments form one translation unit with all raw text and timestamps preserved',()=>{
 const f=mergerFixture();f.merger.add(row('a','The main reason.',1000));f.merger.add(row('b','why this happens.',3000));assert.equal(f.submitted.length,0);
 f.merger.add(row('c','is the increase in demand.',5000));assert.equal(f.submitted.length,1);
 assert.equal(f.submitted[0].source,'The main reason. why this happens. is the increase in demand.');
 assert.deepEqual(f.submitted[0].sourceParts.map(p=>[p.id,p.offset]),[['a',1000],['b',3000],['c',5000]]);assert.deepEqual(f.removed,['b','c']);assert.equal(f.timers.size,0);
});
test('six-second deadline is not extended by more unfinished fragments',()=>{
 const f=mergerFixture();f.merger.add(row('a','Because.'));f.advance(5000);f.merger.add(row('b','of.',5000));f.advance(999);assert.equal(f.submitted.length,0);f.advance(1);assert.equal(f.submitted.length,1);f.merger.flush();assert.equal(f.submitted.length,1);
});
test('language changes and long gaps never merge unrelated turns',()=>{
 for(const [offset,code] of [[1000,'ja'],[20000,'en']]){
  const f=mergerFixture();f.merger.add(row('a','The main reason.'));f.merger.add(row('b','続き',offset,code));assert.equal(f.submitted.length,1);f.merger.flush();assert.equal(f.submitted.length,2);assert.deepEqual(f.removed,[]);
 }
});
async function setup(t){
 await activateClientMembership();const requests=[];
 t.mock.method(globalThis,'fetch',async(path,options)=>{assert.ok(['/api/openai/responses','/api/service/summary'].includes(path));const body=JSON.parse(options.body);requests.push(body);return path==='/api/service/summary'?Response.json({summary:'课堂总结'}):Response.json({output:[{content:[{type:'output_text',text:'合并后的中文译文'}]}]});});
 const live=new BrowserLive();live.paused=false;live.started=Date.now();live.base=0;live.turns={flush(){}};
 live.session={id:crypto.randomUUID(),title:'分句测试',createdAt:new Date().toISOString(),status:'recording',sourceLanguage:'en',segments:[],materials:[],warnings:[],summary:''};
 await saveSession(live.session);t.after(()=>live.close());
 return {live,requests,async commit(id,offset){live.pending++;live.meta.push({sourceLanguage:live.session.sourceLanguage,offset});await live.handle({type:'input_audio_buffer.committed',item_id:id});},async done(id,transcript){await live.handle({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript});}};
}
test('live pipeline merges before the API call, ignores duplicates, and persists one bilingual record',async t=>{
 const f=await setup(t);
 for(const [id,text,offset] of [['a','The main reason.',0],['b','why this happens.',2000],['c','is the increase in demand.',4000]]){await f.commit(id,offset);await f.done(id,text);}
 await f.live.queue;assert.equal(f.requests.length,1);assert.match(f.requests[0].input,/The main reason\. why this happens\. is the increase in demand\./);
 await f.done('b','why this happens.');assert.equal(f.live.session.segments.length,1);assert.equal(f.live.pending,0);
 const saved=await getSession(f.live.session.id);assert.equal(saved.segments[0].translation,'合并后的中文译文');assert.equal(saved.segments[0].sourceParts.length,3);
 await f.live.command({type:'finish',autoSummary:true});for(let i=0;i<100&&!f.live.closed;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.live.closed,true);assert.equal(f.requests.length,2);assert.equal((await getSession(saved.id)).summary,'课堂总结');
});
test('out-of-order completions are merged in committed audio order',async t=>{
 const f=await setup(t);await f.commit('a',0);await f.commit('b',2000);await f.done('b','is the increase in demand.');assert.equal(f.requests.length,0);
 await f.done('a','The main reason.');await f.live.queue;assert.equal(f.live.session.segments.length,1);assert.equal(f.requests.length,1);assert.match(f.requests[0].input,/The main reason\. is the increase in demand\./);
});
test('pause flushes a fragment immediately and late final transcripts are also translated',async t=>{
 const f=await setup(t);await f.commit('a',0);await f.done('a','Because.');assert.equal(f.requests.length,0);
 await f.commit('b',2000);await f.live.command({type:'pause'});await f.live.queue;assert.equal(f.requests.length,1);
 await f.done('b','of demand.');await f.live.queue;assert.equal(f.requests.length,2);assert.equal(f.live.session.segments.length,2);assert.equal(f.live.merger.timer,null);
});
test('finish flushes unfinished text before generating notes',async t=>{
 const f=await setup(t);await f.commit('a',0);await f.done('a','This is because.');assert.equal(f.requests.length,0);
 await f.live.command({type:'finish',autoSummary:true});for(let i=0;i<100&&!f.live.closed;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.live.closed,true);assert.equal(f.requests.length,2);assert.match(f.requests[0].instructions,/同声传译员/);assert.equal(f.requests[1].instructions,undefined);assert.match(f.requests[1].snapshot.segments[0].source,/This is because\./);
});
test('a failed transcription forms a boundary instead of joining speech across missing audio',async t=>{
 const f=await setup(t);await f.commit('a',0);await f.done('a','Because.');await f.commit('missing',1000);await f.commit('c',2000);await f.done('c','the price goes up significantly.');
 await f.live.handle({type:'conversation.item.input_audio_transcription.failed',item_id:'missing'});f.live.merger.flush();await f.live.queue;
 assert.equal(f.requests.length,2);assert.equal(f.live.pending,0);assert.equal(f.live.session.segments.filter(s=>s.source).length,2);
});
test('missing earlier results do not block new text forever and a late result is still retained',async t=>{
 const f=await setup(t);t.mock.timers.enable({apis:['setTimeout']});
 await f.commit('slow',0);await f.commit('ready',2000);await f.done('ready','The market price rises when demand increases.');assert.equal(f.requests.length,0);
 t.mock.timers.tick(6000);await f.live.queue;assert.equal(f.requests.length,1);
 await f.done('slow','Supply remains steady throughout the entire period.');await f.live.queue;assert.equal(f.requests.length,2);
 assert.equal(f.live.session.segments.length,2);assert.equal(f.live.session.segments[0].id,'slow');assert.equal(f.live.session.segments[0].state,'translated');assert.equal(f.live.orderTimer,null);
});
test('continuing a merged classroom uses the last original fragment timestamp',async t=>{
 const f=await setup(t);f.live.session.segments=[{id:'a',offset:1000,source:'Merged text',translation:'合并译文',sourceParts:[{id:'a',offset:1000,source:'First'},{id:'b',offset:5000,source:'second'}]}];await saveSession(f.live.session);
 const resumed=new BrowserLive();resumed.connect=async()=>{};
 try{await resumed.command({type:'start',id:f.live.session.id});assert.equal(resumed.base,6000);}finally{resumed.close();await resumed.queue;}
});

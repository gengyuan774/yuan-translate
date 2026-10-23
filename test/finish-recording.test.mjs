import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserLive} from '../src/live.js';
import {getSession,setAccount} from '../src/storage.js';
import {refreshAccess} from '../src/access.js';
async function fixture(t,{paid=true}={}){
 setAccount(null);
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({member:true,paidMember:paid,tier:paid?'regular':'trial',sharedReady:true});
 try{await refreshAccess();}finally{globalThis.fetch=original;}
 const live=new BrowserLive();live.session={id:crypto.randomUUID(),title:'Finish choices',createdAt:new Date().toISOString(),sourceLanguage:'en',segments:[{id:'a',source:'Opportunity cost is the value of the next best alternative.',translation:'机会成本是放弃的最佳替代方案的价值。',state:'translated',offset:0}],materials:[],warnings:[],summary:'',status:'recording'};
 live.paused=false;live.persist=async()=>{};live.turns={flush(){}};live.upstream={close(){}};
 let resolve;const finished=new Promise(r=>resolve=r);live.onmessage=({data})=>{const event=JSON.parse(data);if(event.type==='finished')resolve(event);};t.after(()=>live.close());
 return {live,finished};
}
test('end recording saves the full transcript without a summary request or summary allowance consumption',async t=>{
 const {live,finished}=await fixture(t);let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('No provider request expected');});
 await live.command({type:'finish',autoSummary:false});const event=await finished;
 assert.equal(event.autoSummary,false);assert.equal(requests,0);assert.equal(live.session.status,'completed');
 const saved=await getSession(live.session.id);assert.equal(saved.segments.length,1);assert.equal(saved.segments[0].translation,live.session.segments[0].translation);assert.equal(saved.summary,'');
});
test('end and summarize explicitly requests one summary after stopping recording and saves it',async t=>{
 const {live,finished}=await fixture(t);let summaries=0;t.mock.method(globalThis,'fetch',async path=>{assert.equal(path,'/api/service/summary');summaries++;return Response.json({summary:'## 课堂概览\n机会成本。'});});
 await live.command({type:'finish',autoSummary:true});const event=await finished;
 assert.equal(event.autoSummary,true);assert.equal(summaries,1);assert.equal((await getSession(live.session.id)).summary,'## 课堂概览\n机会成本。');
});
test('a second finish choice cannot change the first while final audio is still pending',async t=>{
 const {live,finished}=await fixture(t);let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('No summary expected');});live.pending=1;
 await live.command({type:'finish',autoSummary:false});await live.command({type:'finish',autoSummary:true});
 assert.equal(live.finalizing,undefined);assert.equal(live.finishWithSummary,false);
 live.session.segments.push({id:'last',source:'The final sentence.',translation:'最后一句。',state:'translated',offset:1000});live.pending=0;await live.finalize();await finished;
 assert.equal(requests,0);assert.equal((await getSession(live.session.id)).segments.length,2);
});
test('free trial cannot trigger a summary even through an explicit client finish command',async t=>{
 const {live,finished}=await fixture(t,{paid:false});t.mock.method(globalThis,'fetch',async()=>assert.fail('trial finish must not request a summary'));
 await live.command({type:'finish',autoSummary:true});const event=await finished;assert.equal(event.autoSummary,false);assert.equal(event.session.status,'completed');
});

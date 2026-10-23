import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {complete} from '../src/local-api.js';
import {setAccount,getSession,sessionSyncPending,clearLocalAccount} from '../src/storage.js';
import {activateClientMembership} from './access-fixture.mjs';

const lesson=()=>({id:crypto.randomUUID(),title:'课堂',createdAt:new Date().toISOString(),status:'summary_failed',segments:[{id:'a',offset:0,source:'Opportunity cost is the value of the next best alternative.'}],materials:[],warnings:[],summary:'',sourceLanguage:'en'});
const conflict=()=>Response.json({error:{message:'这节课已在其他页面更新，请重新打开记录后继续。'}},{status:409});
const output=()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:'## 课堂概览\n机会成本是放弃的最佳替代方案的价值。'}]}]});

test('summary and local transcript survive a cloud revision conflict without overwriting the cloud',async()=>{
 await activateClientMembership();const original=globalThis.fetch;let generated=0;const writes=[];setAccount({id:'summary-conflict'});
 globalThis.fetch=async(path,init)=>{if(path==='/api/openai/responses'){generated++;return output();}writes.push(JSON.parse(init.body));return conflict();};
 try{
  const s=lesson(),source=structuredClone(s.segments);await complete(s);
  assert.equal(s.status,'completed');assert.match(s.summary,/机会成本/);assert.equal(generated,1);
  const local=await getSession(s.id);assert.equal(local.summary,s.summary);assert.deepEqual(local.segments,source);
  assert.equal(await sessionSyncPending(s.id),true);assert.ok(writes.length);assert.ok(writes.every(w=>w.revision===0));
 }finally{await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});

test('cloud conflict does not mask the actual summary generation error',async()=>{
 await activateClientMembership();const original=globalThis.fetch;setAccount({id:'summary-error'});
 globalThis.fetch=async path=>path==='/api/openai/responses'?Response.json({error:{message:'summary test failure'}},{status:400}):conflict();
 try{
  const s=lesson();await assert.rejects(()=>complete(s),/summary test failure/);
  const local=await getSession(s.id);assert.equal(local.status,'summary_failed');assert.match(local.summaryError,/summary test failure/);assert.equal(local.segments.length,1);
 }finally{await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});

test('summary finishes and is durable locally while cloud sync is still waiting',async()=>{
 await activateClientMembership();const original=globalThis.fetch;let release;setAccount({id:'summary-slow'});
 const gate=new Promise(resolve=>release=resolve);
 globalThis.fetch=async(path,init)=>{if(path==='/api/openai/responses')return output();await gate;return Response.json({revision:JSON.parse(init.body).revision+1});};
 try{
  const s=lesson();let timer;
  try{await Promise.race([complete(s),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Summary waited for cloud sync')),1000);})]);}finally{clearTimeout(timer);}
  assert.equal((await getSession(s.id)).summary,s.summary);assert.equal(s.status,'completed');assert.equal(await sessionSyncPending(s.id),true);
 }finally{release();await clearLocalAccount();setAccount(null);globalThis.fetch=original;}
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {referenceContext} from '../src/materials.js';
import {summarize,translateSegment} from '../src/core.js';
import {cachedSummaryGenerator} from '../src/summary-cache.js';
import {setAccount,saveSession,getSession,saveMaterial,deleteSession,getSummaryMemo,saveSummaryMemo,clearLocalAccount} from '../src/storage.js';
const digest=text=>createHash('sha256').update(text).digest('hex');
const session=()=>({id:crypto.randomUUID(),title:'Economics',createdAt:new Date().toISOString(),status:'ready',segments:[],materials:[],warnings:[],summary:'',sourceLanguage:'en',major:{code:'economics'}});
async function course(){setAccount(null);const s=session();await saveSession(s);return s;}
async function material(s,pages,name='Lecture.pptx'){
 const m={id:crypto.randomUUID(),name,enabled:true,pageCount:pages.length,warnings:[]};s.materials.push(m);
 await saveMaterial(s.id,{...m,pages:pages.map((text,i)=>({label:'第 '+(i+1)+' 页',text}))});await saveSession(s);return m;
}
function generator(){const calls=[];return {calls,generate:async(key,instructions,input)=>{calls.push({instructions,input});return '摘要 '+digest(instructions+input).slice(0,12);}};}

test('reference selection drops unrelated pages while retaining definitions, numbers and provenance',async()=>{
 const s=await course();await material(s,[
  'CPI means Consumer Price Index. CPI rose by 2.5% in 2026.\n消费价格指数用来衡量消费价格变化。',
  'Photosynthesis converts light energy into chemical energy. '.repeat(80),
  'A principal has a responsibility to teach students. '.repeat(80)
 ]);
 const reference=await referenceContext(s,'The CPI rose this year.');
 assert.match(reference.text,/Consumer Price Index/);assert.match(reference.text,/2\.5%/);assert.match(reference.text,/第 1 页/);
 assert.doesNotMatch(reference.text,/Photosynthesis|principal/);assert.equal(reference.references.length,1);
 assert.deepEqual(await referenceContext(s,'Thank you. Please explain.'),{text:'',references:[]});
 assert.deepEqual(await referenceContext(s,'Quantum entanglement'),{text:'',references:[]});
 s.materials[0].enabled=false;assert.deepEqual(await referenceContext(s,'CPI'),{text:'',references:[]});
});
test('reference budget is bounded and ranks rare relevant terms above repeated general terms',async()=>{
 const s=await course();await material(s,Array.from({length:20},(_,i)=>'Economic cost and choices. '.repeat(65)+(i===19?'\nOpportunity cost is the value of the next best alternative.':'\nUnrelated exercise.')));
 const reference=await referenceContext(s,'opportunity cost');
 assert.ok(reference.text.length<=4000);assert.match(reference.text,/next best alternative/);assert.equal(reference.references[0].label,'第 20 页');
 const chinese=await material(s,['机会成本表示放弃的最佳替代选择的价值。增长率为 3.5%。'],'中文课件.pdf');
 const result=await referenceContext(s,'机会成本');assert.ok(result.references.some(r=>r.id===chinese.id));assert.match(result.text,/3\.5%/);
});
test('compact excerpts preserve acronym disambiguation, translation context and streaming',async()=>{
 const s=await course();s.segments=[{id:'old',source:'Consumer prices increased.',translation:'消费价格上涨。'}];
 await material(s,['CPI = Consumer Price Index. Formula: CPI = basket cost / base cost * 100.']);
 let request,partial='';
 const output=await translateSegment(s,'member','CPI increased.','Consumer prices increased.',async(k,instructions,input,options)=>{
  request={instructions,input,options};options.onDelta('消费价格指数');return '消费价格指数（CPI）上涨了。';
 },'en',text=>partial=text);
 assert.match(request.instructions,/不猜测全称/);assert.match(request.input,/消费价格上涨/);assert.match(request.input,/basket cost/);
 assert.equal(request.options.maxTokens,1800);assert.equal(partial,'消费价格指数');assert.equal(output.references.length,1);
});
test('unchanged classroom summary is reused after reopening without another generation request',async()=>{
 const s=await course();s.segments=[{id:'a',offset:0,source:'Opportunity cost is a trade-off.'}];await saveSession(s);
 const {calls,generate}=generator();s.summary=await summarize(s,'member',generate);await saveSession(s);
 const reopened=await getSession(s.id);assert.equal(await summarize(reopened,'member',generate),s.summary);assert.equal(calls.length,1);
 reopened.title='Different course';await summarize(reopened,'member',generate);assert.equal(calls.length,2);
 reopened.major={code:'finance'};await summarize(reopened,'member',generate);assert.equal(calls.length,3);
 reopened.warnings=['部分语音缺失'];await summarize(reopened,'member',generate);assert.equal(calls.length,4);
});
test('new classroom content reuses unchanged document and transcript chunks; edited or disabled documents invalidate affected work',async()=>{
 const s=await course();s.segments=[{id:'a',offset:0,source:'Opportunity cost is an economic concept. '.repeat(520)}];
 const m=await material(s,['Marginal utility: a change in satisfaction. '.repeat(660)]);
 const {calls,generate}=generator();await summarize(s,'member',generate);const initial=calls.length;assert.ok(initial>=5);
 await summarize(s,'member',generate);assert.equal(calls.length,initial);
 s.segments.push({id:'b',offset:60000,source:'New lecture fact: inflation is 3.5%.'});
 await summarize(s,'member',generate);const added=calls.slice(initial);
 assert.ok(added.length<initial);assert.equal(added.filter(c=>c.instructions.includes('整理这一段参考资料')).length,0);
 assert.ok(added.some(c=>c.input.includes('3.5%')));
 const beforeEdit=calls.length;await saveMaterial(s.id,{...m,pages:[{label:'第 1 页',text:'Edited definition: marginal utility can be negative. '.repeat(520)}]});
 await summarize(s,'member',generate);assert.ok(calls.slice(beforeEdit).some(c=>c.instructions.includes('整理这一段参考资料')));
 const beforeDisable=calls.length;m.enabled=false;await summarize(s,'member',generate);
 assert.ok(calls.length>beforeDisable);assert.match(calls.at(-1).input,/未导入资料/);
});
test('failed or empty generations are not cached, and concurrent identical requests share one call',async()=>{
 const s=await course();let calls=0,release;
 const generate=async()=>{calls++;if(calls===1)throw Error('upstream unavailable');if(calls===2)return '';await new Promise(r=>release=r);return '完整摘要';};
 const a=cachedSummaryGenerator(s,generate),b=cachedSummaryGenerator(s,generate);
 await assert.rejects(()=>a('member','instruction','input'),/upstream unavailable/);
 await assert.rejects(()=>a('member','instruction','input'),/完整/);
 const first=a('member','instruction','input'),second=b('member','instruction','input');
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(calls,3);release();assert.deepEqual(await Promise.all([first,second]),['完整摘要','完整摘要']);
 assert.equal(await b('member','instruction','input'),'完整摘要');assert.equal(calls,3);
});
test('request cache includes the full prompt and output limit and never contains the API credential',async()=>{
 const s=await course(),{calls,generate}=generator(),request=cachedSummaryGenerator(s,generate);
 await request('private-key-never-store','version 1','input',{maxTokens:1800});
 await request('private-key-never-store','version 1','input',{maxTokens:1800});assert.equal(calls.length,1);
 await request('private-key-never-store','version 2','input',{maxTokens:1800});
 await request('private-key-never-store','version 2','input',{maxTokens:2000});assert.equal(calls.length,3);
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('classroom-notes-summary-cache');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const data=await new Promise(resolve=>{const r=db.transaction('summary-cache').objectStore('summary-cache').get(s.id);r.onsuccess=()=>resolve(r.result);});
 assert.doesNotMatch(JSON.stringify(data),/private-key-never-store|version 1|"input"/);
});
test('summary cache isolates accounts and classrooms, and follows local account and classroom deletion',async t=>{
 t.mock.method(globalThis,'fetch',async(url,init)=>Response.json({revision:JSON.parse(init.body).revision+1}));
 const s=session(),{calls,generate}=generator();
 for(const id of ['memo-account-a','memo-account-b']){
  setAccount({id});await saveSession(s);await cachedSummaryGenerator(s,generate)('member','same','same');
 }
 assert.equal(calls.length,2);
 setAccount({id:'memo-account-a'});await cachedSummaryGenerator(s,generate)('member','same','same');assert.equal(calls.length,2);
 await clearLocalAccount();await saveSession(s);await cachedSummaryGenerator(s,generate)('member','same','same');assert.equal(calls.length,3);
 await clearLocalAccount();setAccount({id:'memo-account-b'});await clearLocalAccount();setAccount(null);
 const guest=await course();await saveSummaryMemo(null,guest.id,'hash','摘要');assert.equal(await getSummaryMemo(null,guest.id,'hash'),'摘要');
 const other=await course();assert.equal(await getSummaryMemo(null,other.id,'hash'),null);
 await deleteSession(guest.id);assert.equal(await getSummaryMemo(null,guest.id,'hash'),null);
 await saveSummaryMemo(null,guest.id,'late-result','迟到的摘要');assert.equal(await getSummaryMemo(null,guest.id,'late-result'),null);
});
test('changing account while generating rejects the old result instead of caching it under another account',async()=>{
 const s=await course();let release;
 const request=cachedSummaryGenerator(s,async()=>{await new Promise(r=>release=r);return '原账户摘要';});
 const pending=request('member','instructions','input');
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));
 setAccount({id:'new-account'});release();await assert.rejects(()=>pending,/账户已变化/);setAccount(null);
});

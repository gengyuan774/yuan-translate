import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
import {summarizeService,normalizeSummarySnapshot} from '../src/summary-service.js';
import {myUsage} from '../src/service-ledger.js';
import {summarize} from '../src/core.js';
import {setAccount,saveMaterial,deleteSession} from '../src/storage.js';

const snapshot=(text='The opportunity cost is the next best alternative.')=>({title:'经济学',major:{code:'economics'},warnings:[],segments:Array.from({length:Math.ceil(text.length/16000)},(_,i)=>({offset:i*8000,source:text.slice(i*16000,(i+1)*16000)})),materials:[]});
const body=text=>({id:crypto.randomUUID(),snapshot:snapshot(text)});
const output=(text='## 课堂概览\n机会成本。')=>Response.json({status:'completed',output:[{content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:20}});
async function fixture(tier='regular'){
 const f=environment(),account=await createVerifiedAccountSession(f.env,{provider:'email',subject:crypto.randomUUID()+'@test.example',label:'summary-test'}),cookie=account.cookie.split(';')[0];
 const batch=f.env.DB.batch.bind(f.env.DB);let previous=Promise.resolve();f.env.DB.batch=items=>{const run=previous.then(()=>batch(items));previous=run.catch(()=>{});return run;};
 if(tier!=='trial')f.sql.prepare('UPDATE account_memberships SET tier=?,expires_at=?,updated_at=?,quota_anchor=? WHERE account_id=?').run(tier,Date.now()+365*86400000,Date.now(),Date.now(),account.user.id);
 const request=req('/api/service/summary',{},cookie,{'X-Access-Mode':'member'});
 return {...f,account:account.user,cookie,request,run:(data,upstream=async()=>output())=>summarizeService(request,f.env,data,upstream)};
}

test('a multi-stage long classroom and selected PPT consume one summary while recording all internal provider costs',async()=>{
 const f=await fixture(),data=body('The lesson explains opportunity cost. '.repeat(1000)),seen=[];
 data.snapshot.materials=[{id:crypto.randomUUID(),name:'lecture.pptx',warnings:[],pages:[{label:'第 1 页',text:'CPI = Consumer Price Index. '.repeat(700)}]}];
 const response=await f.run(data,async(url,init)=>{const p=JSON.parse(init.body);seen.push(p);assert.equal(url,'https://api.openai.com/v1/responses');assert.match(p.instructions,/不可信的数据/);assert.match(p.input,/经济学/);return output();});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.summarySources[0].name,'lecture.pptx');assert.equal(result.summaryScope,'classroom');
 assert.ok(seen.length>=5);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM service_requests WHERE state='completed'").get().n,seen.length);
 const usage=await myUsage(f.request,f.env);assert.equal(usage.summariesUsed,1);assert.equal(usage.summariesReserved,0);assert.equal(usage.summariesRemaining,9);
});

test('summary frequency checks count the whole operation once even when it needs more than sixty provider stages',async()=>{
 const f=await fixture(),data=body('x'.repeat(900000));let calls=0;
 data.snapshot.materials=[200000,200000,100000].map((n,i)=>({id:crypto.randomUUID(),name:'selected-'+i+'.txt',pages:[{label:'第 1 页',text:'y'.repeat(n)}]}));
 const response=await handle(req('/api/service/summary',data,f.cookie,{'X-Access-Mode':'member'}),async()=>{calls++;return output();},f.env);
 assert.equal(response.status,200,await response.clone().text());assert.ok(calls>60);assert.equal((await myUsage(f.request,f.env)).summariesUsed,1);
 const bucket=f.sql.prepare("SELECT count FROM usage_buckets WHERE id LIKE ?").get('text-minute:'+f.account.id+':%');assert.equal(bucket.count,1);
 assert.equal(f.sql.prepare("SELECT count FROM usage_buckets WHERE id LIKE 'text-day:%'").get().count,1);
});

test('normalized completed snapshots are cached per account, including when that month has no summaries left',async()=>{
 const f=await fixture(),first=body('CPI\r\nrose by 2.5%.'),data=structuredClone(first);let calls=0;
 await f.run(first,async()=>{calls++;return output();});
 data.id=crypto.randomUUID();data.snapshot.segments[0].source='CPI\nrose by 2.5%.';data.snapshot.untrustedClientMetadata='ignored';
 const cached=await f.run(data,async()=>{calls++;return output();});assert.equal((await cached.json()).cached,true);assert.equal(calls,1);
 for(let i=1;i<10;i++)await f.run(body('Different lesson '+i));
 await assert.rejects(()=>f.run(body('This would be number eleven')),e=>e.status===402);
 assert.equal((await myUsage(f.request,f.env)).summariesUsed,10);
 assert.equal((await (await f.run(data,()=>{throw Error('Cached data must not call API');})).json()).cached,true);
 const other=await fixture();let otherCalls=0;await other.run({...first,id:crypto.randomUUID()},async()=>{otherCalls++;return output();});assert.equal(otherCalls,1);
});

test('failed internal generation refunds the whole summary and a fresh attempt can succeed',async()=>{
 const f=await fixture(),data=body('A long classroom paragraph. '.repeat(1300));let calls=0;
 await assert.rejects(()=>f.run(data,async()=>++calls===2?Response.json({error:{code:'server_error'}},{status:500}):output()),e=>e.status===500);
 let usage=await myUsage(f.request,f.env);assert.equal(usage.summariesUsed,0);assert.equal(usage.summariesReserved,0);
 await f.run({...data,id:crypto.randomUUID()});usage=await myUsage(f.request,f.env);assert.equal(usage.summariesUsed,1);assert.equal(usage.summariesReserved,0);
});

test('concurrent duplicates return conflict, then reuse the result; an operation id cannot change its source data',async()=>{
 const f=await fixture(),data=body();let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const first=f.run(data,async()=>{entered();await gate;return output();});await started;
 try{await assert.rejects(()=>f.run({...data,id:crypto.randomUUID()}),e=>e.status===409);}finally{release();}
 await first;assert.equal((await (await f.run(data,()=>{throw Error('No duplicate API request');})).json()).cached,true);
 await assert.rejects(()=>f.run({...data,snapshot:snapshot('Different content')}),e=>e.status===409);
 assert.equal((await myUsage(f.request,f.env)).summariesUsed,1);
});

test('simultaneous identical operation ids reserve one summary and dispatch one provider request',async()=>{
 const f=await fixture(),data=body();let release,entered,calls=0;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const upstream=async()=>{calls++;entered();await gate;return output();};
 const first=f.run(data,upstream),second=f.run(data,upstream);
 const results=Promise.allSettled([first,second]);await started;
 try{const rejection=await Promise.race([first,second].map(p=>p.then(()=>null,error=>error)));assert.equal(rejection.status,409);}finally{release();}
 const settled=await results;assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
 const usage=await myUsage(f.request,f.env);assert.equal(usage.summariesUsed,1);assert.equal(usage.summariesReserved,0);
});

test('trial accounts cannot summarize and gold members have no summary count limit',async()=>{
 const trial=await fixture('trial');let calls=0;await assert.rejects(()=>trial.run(body(),async()=>{calls++;return output();}),e=>e.status===402);assert.equal(calls,0);
 const premium=await fixture('premium');for(let i=0;i<11;i++)await premium.run(body('Gold lesson '+i));
 const usage=await myUsage(premium.request,premium.env);assert.equal(usage.summaries,null);assert.equal(usage.summariesRemaining,null);assert.equal(usage.summariesUsed,11);
});

test('summary snapshots reject malformed or oversized data before making provider requests',async()=>{
 const f=await fixture();let calls=0;const upstream=async()=>{calls++;return output();};
 for(const data of [{...body(),id:'invalid'},body(''),{...body(),snapshot:{...snapshot(),segments:[{offset:-1,source:'x'}]}},{...body(),snapshot:{...snapshot(),materials:[{id:crypto.randomUUID(),name:'x',pages:[{label:'1',text:'x'.repeat(200001)}]}]}}])await assert.rejects(()=>f.run(data,upstream),e=>[400,413].includes(e.status));
 const oversized=snapshot();oversized.segments=Array.from({length:51},(_,i)=>({offset:i*1000,source:'x'.repeat(20000)}));assert.throws(()=>normalizeSummarySnapshot(oversized),e=>e.status===413);
 assert.equal(calls,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM service_summary_jobs').get().n,0);
});

test('the real client sends one source snapshot with selected files only and no provider prompts',async()=>{
 setAccount(null);const s={id:crypto.randomUUID(),...snapshot(),materials:[]},original=globalThis.fetch;let request;
 for(const [enabled,text] of [[true,'SELECTED REFERENCE'],[false,'PRIVATE UNSELECTED REFERENCE']]){const m={id:crypto.randomUUID(),name:enabled?'selected.pdf':'ignored.pdf',enabled,pageCount:1,warnings:[]};s.materials.push(m);await saveMaterial(s.id,{...m,pages:[{label:'第 1 页',text}]});}
 globalThis.fetch=async(path,init)=>{assert.equal(path,'/api/service/summary');request=JSON.parse(init.body);return Response.json({summary:'整理完成',summarySources:[{id:s.materials[0].id,name:'selected.pdf',pageCount:1,warnings:[]}],summaryScope:'classroom'});};
 try{assert.equal(await summarize(s,'member'),'整理完成');assert.equal(request.snapshot.materials.length,1);assert.equal(request.instructions,undefined);assert.match(JSON.stringify(request),/SELECTED REFERENCE/);assert.doesNotMatch(JSON.stringify(request),/PRIVATE UNSELECTED/);assert.equal(s.summaryScope,'classroom');assert.equal(s.summaryStale,false);}finally{globalThis.fetch=original;await deleteSession(s.id);}
});

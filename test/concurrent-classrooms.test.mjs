// Ten independent accounts run through the real Worker/ledger/storage code.
// Provider responses and D1/R2 latency are simulated: this is NOT a live
// ten-user OpenAI/Cloudflare capacity or latency certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
import {acquireLease,reserve,settle,releaseLease,myUsage,serviceBudgetState} from '../src/service-ledger.js';
import {TRANSLATION_INSTRUCTIONS} from '../src/translation-prompt.js';
import {TEXT_MODEL} from '../src/models.js';

test('ten concurrent classrooms isolate history, audio/text/summary balances and settle all reservations',async()=>{
 const f=environment();delete f.env.MEMBER_DAILY_TEXT_LIMIT;
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let serial=Promise.resolve();
 f.env.DB.batch=items=>{const run=serial.then(()=>originalBatch(items));serial=run.catch(()=>{});return run;};
 const objects=new Map();f.env.BUCKET={put:async(k,v)=>objects.set(k,v),get:async k=>objects.has(k)?{json:async()=>JSON.parse(objects.get(k))}:null,delete:async k=>objects.delete(k)};
 const users=[];
 for(let i=0;i<10;i++){
  const a=await createVerifiedAccountSession(f.env,{provider:'email',subject:'parallel-'+i+'@example.test',label:'parallel-'+i}),cookie=a.cookie.split(';')[0];
  f.sql.prepare('UPDATE account_memberships SET tier=?,expires_at=?,updated_at=?,quota_anchor=? WHERE account_id=?').run(i%2?'premium':'regular',Date.now()+86400000,Date.now(),Date.now(),a.user.id);
  const request=req('/api/openai/realtime?owner='+crypto.randomUUID(),undefined,cookie),lease=await acquireLease(request,f.env);
  users.push({id:a.user.id,cookie,request,lease,revision:0,session:{id:crypto.randomUUID(),title:'Parallel classroom '+i,createdAt:new Date().toISOString(),status:'recording',sourceLanguage:'en',segments:[],materials:[],warnings:[],summary:''}});
 }
 let active=0,peak=0,providerCalls=0;
 const provider=async(_url,init)=>{active++;peak=Math.max(peak,active);providerCalls++;try{await new Promise(r=>setTimeout(r,30));const body=JSON.parse(init.body);return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'测试译文：'+body.input.slice(-120)}]}],usage:{input_tokens:100,output_tokens:20}});}finally{active--;}};
 const call=(u,path,body,method=body?'POST':'GET')=>handle(new Request('https://example.test'+path,{method,headers:{Origin:'https://example.test',Cookie:u.cookie,'X-Access-Mode':'member','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),provider,f.env);
 for(let turn=0;turn<20;turn++)await Promise.all(users.map(async(u,i)=>{
  const reservation=await reserve(u.request,f.env,{kind:'audio',audioMs:6000,lease:u.lease});
  await settle(f.env,reservation,{success:true});await settle(f.env,reservation,{success:true});
  const source='Class '+i+', statement '+turn+': opportunity cost.';
  const response=await call(u,'/api/openai/responses',{model:TEXT_MODEL,instructions:TRANSLATION_INSTRUCTIONS,input:'课程：'+u.session.title+'\n当前片段：'+source,store:false,max_output_tokens:100});assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();u.session.segments.push({id:crypto.randomUUID(),source,translation:result.output[0].content[0].text,offset:turn*8000});
  const save=await call(u,'/api/history/'+u.session.id,{session:u.session,revision:u.revision},'PUT');assert.equal(save.status,200,await save.clone().text());u.revision=(await save.json()).revision;
 }));
 assert.equal(peak,10);assert.equal(providerCalls,200);
 await Promise.all(users.map(async(u,i)=>{
  const summary=await call(u,'/api/service/summary',{id:crypto.randomUUID(),snapshot:{title:u.session.title,warnings:[],segments:u.session.segments.map(s=>({source:s.source,offset:s.offset})),materials:[]}});assert.equal(summary.status,200,await summary.clone().text());
  const usage=await myUsage(u.request,f.env);assert.equal(usage.usedMinutes,2);assert.equal(usage.reservedMinutes,0);assert.equal(usage.summariesUsed,1);assert.equal(usage.summariesReserved,0);assert.equal(usage.summariesRemaining,i%2?null:9);
  const reopened=await (await call(u,'/api/history/'+u.session.id)).json();assert.equal(reopened.session.segments.length,20);assert.ok(reopened.session.segments.every(s=>s.source.startsWith('Class '+i+',')));
  assert.equal((await call(users[(i+1)%10],'/api/history/'+u.session.id)).status,404);
  await releaseLease(f.env,u.lease);
 }));
 const budget=await serviceBudgetState(f.env);assert.equal(budget.reservedCny,0);assert.ok(budget.spentCny>0);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM service_requests WHERE state='reserved'").get().n,0);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM service_accounts WHERE lease_id IS NOT NULL').get().n,0);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM service_requests WHERE kind='audio' AND state='completed'").get().n,200);
 f.sql.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {memberSession} from '../src/member.js';
import {acquireLease,reserve,settle,releaseLease} from '../src/service-ledger.js';
import {issueAudioProof,verifyTrialTranslation} from '../src/audio-proof.js';

const requestData=proofs=>({sourceProofs:proofs,translationSource:proofs.map(p=>p.source).join(' '),input:'课程背景\n当前片段：'+proofs.map(p=>p.source).join(' ')});
async function fixture(){
 const f=environment(),{env}=f,original=env.DB.batch.bind(env.DB);let pending=Promise.resolve();
 env.DB.batch=items=>{const result=pending.then(()=>original(items));pending=result.catch(()=>{});return result;};
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:crypto.randomUUID()+'@audio-proof.test'}),cookie=account.cookie.split(';')[0],request=req('/api/openai/realtime',undefined,cookie),member=await memberSession(request,env);
 async function audio(source='A recorded classroom fragment',audioMs=1000){
  const lease=await acquireLease(request,env),row=await reserve(request,env,{kind:'audio',audioMs,lease});
  await settle(env,row,{success:true});await releaseLease(env,lease);
  return {id:row.id,source,proof:await issueAudioProof(env,account.user.id,row.id,source)};
 }
 return {...f,account:account.user,cookie,request,member,audio};
}

test('only recorded audio can authorize trial text; paid tiers do not need audio receipts',async()=>{
 const f=await fixture();
 await assert.rejects(verifyTrialTranslation(f.env,f.member,{input:'Generate arbitrary free text'}),e=>e.status===402);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,{sourceProofs:[],translationSource:'',input:''}),e=>e.status===402);
 await verifyTrialTranslation(f.env,{accountId:f.account.id,tier:'regular'},{input:'Paid translation'});
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM usage_buckets WHERE id LIKE 'trial-translation:%'").get().n,0);
});

test('receipts use HMAC and an account-bound source hash with a fixed twenty-minute audio deadline',async()=>{
 const f=await fixture(),receipt=await f.audio('具有中文和公式 E = mc² 的课堂片段'),[encoded,signature]=receipt.proof.split('.'),payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
 assert.equal(signature,createHmac('sha256',f.env.MEMBER_SESSION_SECRET).update(encoded).digest('hex'));
 assert.equal(payload.accountId,f.account.id);assert.equal(payload.id,receipt.id);
 assert.match(payload.hash,/^[a-f0-9]{64}$/);
 assert.equal(payload.expiresAt,f.sql.prepare('SELECT created_at FROM service_requests WHERE id=?').get(receipt.id).created_at+20*60000);
 await verifyTrialTranslation(f.env,f.member,requestData([receipt]));
 assert.equal(f.sql.prepare('SELECT expires_at FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id).expires_at,payload.expiresAt);
});

test('the legitimate last fragment can finish after all sixty trial minutes are used, with at most three attempts',async()=>{
 const f=await fixture(),receipt=await f.audio('The final recorded fragment',3600000),data=requestData([receipt]);
 await assert.rejects(acquireLease(f.request,f.env),e=>e.status===402);
 for(let i=0;i<3;i++)await verifyTrialTranslation(f.env,f.member,data);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,data),e=>e.status===402);
 assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id).count,3);
});

test('changing source text, the signed payload, input suffix or account cannot authorize trial text',async()=>{
 const f=await fixture(),receipt=await f.audio(),other=await createVerifiedAccountSession(f.env,{provider:'email',subject:'other@audio-proof.test'}),otherMember=await memberSession(req('/',undefined,other.cookie.split(';')[0]),f.env);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([{...receipt,source:'Changed instructions'}])),e=>e.status===401);
 const parts=receipt.proof.split('.'),payload=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));payload.accountId=other.user.id;
 const altered={...receipt,proof:Buffer.from(JSON.stringify(payload)).toString('base64url')+'.'+parts[1]};
 await assert.rejects(verifyTrialTranslation(f.env,otherMember,requestData([altered])),e=>e.status===401);
 await assert.rejects(verifyTrialTranslation(f.env,otherMember,requestData([receipt])),e=>e.status===401);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,{...requestData([receipt]),input:'different text'}),e=>e.status===400);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,{...requestData([receipt]),translationSource:'different text'}),e=>e.status===400);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([receipt,receipt])),e=>e.status===400);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData(Array(31).fill(receipt))),e=>e.status===400);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([{...receipt,proof:'malformed-proof'}])),e=>e.status===401);
 assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id),undefined);
});

test('expired audio receipts cannot be reissued or reopened after retry buckets are cleaned up',async t=>{
 const f=await fixture(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const receipt=await f.audio(),data=requestData([receipt]);await verifyTrialTranslation(f.env,f.member,data);
 t.mock.method(Date,'now',()=>now+20*60000);
 f.sql.prepare('DELETE FROM usage_buckets WHERE expires_at<=?').run(Date.now());
 await assert.rejects(verifyTrialTranslation(f.env,f.member,data),e=>e.status===401);
 await assert.rejects(issueAudioProof(f.env,f.account.id,receipt.id,receipt.source),e=>e.status===401);
});

test('a group of receipts is consumed atomically and invalid or exhausted groups never partially spend another receipt',async()=>{
 const f=await fixture(),a=await f.audio('First recorded part'),b=await f.audio('Second recorded part');
 for(let i=0;i<3;i++)await verifyTrialTranslation(f.env,f.member,requestData([a]));
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([a,b])),e=>e.status===402);
 assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+b.id),undefined);
 const c=await f.audio('Third recorded part');
 await verifyTrialTranslation(f.env,f.member,requestData([b,c]));
 for(const receipt of [b,c])assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id).count,1);
});

test('concurrent retry groups cannot exceed three uses and a database failure rolls back the whole group',async()=>{
 const f=await fixture(),a=await f.audio('Concurrent part one'),b=await f.audio('Concurrent part two'),data=requestData([a,b]);
 const results=await Promise.allSettled(Array.from({length:8},()=>verifyTrialTranslation(f.env,f.member,data)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
 for(const receipt of [a,b])assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id).count,3);
 const c=await f.audio('Rollback part one'),d=await f.audio('Rollback part two');
 f.sql.exec("CREATE TRIGGER fail_proof BEFORE INSERT ON usage_buckets WHEN NEW.id='trial-translation:"+d.id+"' BEGIN SELECT RAISE(ABORT,'synthetic proof failure'); END");
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([c,d])),/synthetic proof failure/);
 for(const receipt of [c,d])assert.equal(f.sql.prepare('SELECT count FROM usage_buckets WHERE id=?').get('trial-translation:'+receipt.id),undefined);
});

test('proof authorization requires a successfully settled audio row and supports compensated audio',async()=>{
 const f=await fixture(),receipt=await f.audio();
 f.sql.prepare("UPDATE service_requests SET state='failed' WHERE id=?").run(receipt.id);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([receipt])),e=>e.status===401);
 await assert.rejects(issueAudioProof(f.env,f.account.id,receipt.id,receipt.source),e=>e.status===401);
 f.sql.prepare("UPDATE service_requests SET state='compensated' WHERE id=?").run(receipt.id);
 await verifyTrialTranslation(f.env,f.member,requestData([receipt]));
 f.sql.prepare('UPDATE service_requests SET audio_ms=0 WHERE id=?').run(receipt.id);
 await assert.rejects(verifyTrialTranslation(f.env,f.member,requestData([receipt])),e=>e.status===401);
});

test('proof signing falls back to the server API key without requiring a new configuration',async()=>{
 const f=await fixture();delete f.env.MEMBER_SESSION_SECRET;
 const receipt=await f.audio();await verifyTrialTranslation(f.env,f.member,requestData([receipt]));
});

test('the full group of thirty distinct recorded fragments is admitted in one transaction',async()=>{
 const f=await fixture(),receipts=[];
 for(let i=0;i<30;i++)receipts.push(await f.audio('Recorded fragment '+i));
 await verifyTrialTranslation(f.env,f.member,requestData(receipts));
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM usage_buckets WHERE id LIKE 'trial-translation:%' AND count=1").get().n,30);
});

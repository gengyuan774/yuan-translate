import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession,issueAccountSession} from '../src/account-server.js';
import {passwordAccount} from '../src/password-server.js';
import {mintRegistration} from './registration-fixture.mjs';
import {loginMember,membershipFor,memberSession,allowSharedRequest} from '../src/member.js';
import {updateAdminMembership} from '../src/admin-membership.js';
import {trialFor} from '../src/trial.js';
import {digest} from '../src/security-common.js';
import {historyRoute} from '../src/history-server.js';
import {serviceState,acquireLease,releaseLease,reserve,settle,myUsage,beginSummary,finishSummary} from '../src/service-ledger.js';

const password='Isolated trial fixture password 7';
const cookie=result=>result.cookie.split(';')[0];
async function passwordRegistration(env,username){const challenge=await mintRegistration(env,username),data={username,password,registration:challenge.registration};return passwordAccount(req('/api/account/register/password',data,challenge.cookie,challenge.headers),env,data,true);}

test('new verified identities receive exactly one trial and repeat sign-in keeps its original grant',async t=>{
 for(const provider of ['email','phone','wechat']){
  const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
  const identity={provider,subject:provider==='phone'?'+8613800138000':provider+'-identity',label:'Trial account'};
  const first=await createVerifiedAccountSession(env,identity);
  const expected={tier:'trial',active:true,accountId:first.user.id,expiresAt:null,trial:true,periodAnchor:now};
  assert.deepEqual(await trialFor(env,first.user.id),expected);
  assert.deepEqual(await memberSession(req('/api/member/status',undefined,cookie(first)),env),expected);
  t.mock.method(Date,'now',()=>now+86400000);
  const again=await createVerifiedAccountSession(env,identity);
  assert.equal(again.user.id,first.user.id);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,1);
  assert.deepEqual(await trialFor(env,again.user.id),expected);
  t.mock.restoreAll();
 }
});

test('logging in or issuing sessions for legacy accounts never backfills a new-account trial',async()=>{
 const {env,sql}=environment(),id='legacy-account',subject='legacy@example.test';
 sql.prepare('INSERT INTO accounts(id,provider,subject_hash,label,created_at) VALUES(?,?,?,?,?)').run(id,'email',await digest('email:'+subject),'Legacy account',1);
 const signedIn=await createVerifiedAccountSession(env,{provider:'email',subject});
 assert.equal(signedIn.user.id,id);
 await issueAccountSession(env,signedIn.user);
 assert.equal(await trialFor(env,id),null);
 assert.equal(await memberSession(req('/api/member/status',undefined,cookie(signedIn)),env),null);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,0);
});

test('password registration grants once, duplicate registration and later login cannot refill it',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const credentials={username:'trialuser',password};
 const created=await passwordRegistration(env,credentials.username);
 assert.equal((await trialFor(env,created.user.id)).periodAnchor,now);
 await assert.rejects(passwordRegistration(env,credentials.username),e=>e.status===409);
 t.mock.method(Date,'now',()=>now+600000);
 const signedIn=await passwordAccount(req('/api/account/login/password',credentials),env,credentials,false);
 assert.equal(signedIn.user.id,created.user.id);
 assert.equal((await trialFor(env,signedIn.user.id)).periodAnchor,now);
 // An older account with no trial remains ineligible after an ordinary login.
 sql.prepare('DELETE FROM account_trials WHERE account_id=?').run(created.user.id);
 await passwordAccount(req('/api/account/login/password',credentials),env,credentials,false);
 assert.equal(await trialFor(env,created.user.id),null);
});

test('registration and trial rollback together if a trial grant fails',async()=>{
 const {env,sql}=environment();
 sql.exec("CREATE TRIGGER reject_trial BEFORE INSERT ON account_trials BEGIN SELECT RAISE(ABORT,'synthetic trial failure'); END");
 await assert.rejects(createVerifiedAccountSession(env,{provider:'email',subject:'rollback@example.test'}),/synthetic trial failure/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
 await assert.rejects(passwordRegistration(env,'rollbackuser'),/synthetic trial failure/);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM account_passwords').get().n,0);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,0);
});

test('paid membership takes priority over the trial and redemption keeps a stable quota anchor',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'paid-priority@example.test'}),request=req('/api/member/login',{},cookie(account));
 const first=await loginMember(request,env,env.MEMBER_CODE);
 assert.equal(first.tier,'regular');assert.equal(first.periodAnchor,now);
 assert.equal((await memberSession(request,env)).tier,'regular');
 t.mock.method(Date,'now',()=>now+86400000);env.MEMBER_CODE='new-rotated-test-code';
 assert.equal((await loginMember(request,env,env.MEMBER_CODE)).periodAnchor,now);
 assert.equal(sql.prepare('SELECT quota_anchor FROM account_memberships').get().quota_anchor,now);
 t.mock.method(Date,'now',()=>now+9*86400000);env.MEMBER_CODE='expired-renewal-test-code';
 assert.equal((await memberSession(request,env)).tier,'trial');
 const renewed=await loginMember(request,env,env.MEMBER_CODE);
 assert.equal(renewed.periodAnchor,now+9*86400000);
 assert.equal((await trialFor(env,account.user.id)).periodAnchor,now);
});

test('manual extensions and tier changes preserve the anchor until membership truly expires',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await passwordRegistration(env,'manualtrial'),id=account.user.id;
 let updatedAt=sql.prepare('SELECT updated_at FROM account_memberships WHERE account_id=?').get(id).updated_at;
 const update=async(days,tier='regular')=>{
  const result=await updateAdminMembership(env,{username:'manualtrial',accountId:id,tier,expiresAt:new Date(Date.now()+days*86400000).toISOString(),expectedUpdatedAt:updatedAt,reason:'Isolated fixture grant'});
  updatedAt=result.updatedAt;return membershipFor(env,id);
 };
 assert.equal((await update(30)).periodAnchor,now);
 t.mock.method(Date,'now',()=>now+5*86400000);
 assert.equal((await update(30)).periodAnchor,now);
 assert.equal((await update(30,'premium')).periodAnchor,now);
 t.mock.method(Date,'now',()=>now+36*86400000);
 assert.equal((await update(30)).periodAnchor,now+36*86400000);
});

test('continuous paid renewals and tier changes keep the first anchor while gaps start a new period',async t=>{
 const day=86400000,order=(tier,start,end)=>({tier,state:'paid',review_reason:null,grant_start:start*day,grant_end:end*day});
 let orders=[order('regular',0,30),order('regular',30,60),order('regular',60,90)];
 const env={DB:{prepare(){return {bind(){return {async first(){return null;},async all(){return {results:orders};}};}};}}};
 t.mock.method(Date,'now',()=>61*day);
 assert.equal((await membershipFor(env,'isolated-payment')).periodAnchor,0);
 orders=[order('regular',0,30),order('premium',30,60),order('regular',60,90)];
 assert.equal((await membershipFor(env,'isolated-payment')).periodAnchor,0);
 orders=[order('regular',0,30),order('regular',31,90)];
 assert.equal((await membershipFor(env,'isolated-payment')).periodAnchor,31*day);
});

test('trial sessions still require an authentic active account',async()=>{
 const {env,sql}=environment(),account=await createVerifiedAccountSession(env,{provider:'email',subject:'security@example.test'});
 assert.equal(await memberSession(req('/api/member/status'),env),null);
 assert.equal(await memberSession(req('/api/member/status',undefined,'__Host-classroom_account='+'a'.repeat(64)),env),null);
 sql.prepare("UPDATE account_security SET status='banned' WHERE account_id=?").run(account.user.id);
 assert.equal(await memberSession(req('/api/member/status',undefined,cookie(account)),env),null);
});

test('default shared request limits retain minute abuse protection without hidden daily package caps',async t=>{
 const {env,sql}=environment(),now=Date.now();delete env.MEMBER_DAILY_TEXT_LIMIT;t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'daily-caps@example.test'}),request=req('/api/openai/responses',{},cookie(account));
 for(let i=0;i<13;i++){t.mock.method(Date,'now',()=>now+i*61000);await allowSharedRequest(request,env,'token');}
 await allowSharedRequest(request,env,'text',6000000);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM usage_buckets WHERE id LIKE 'realtime-day:%' OR id LIKE 'text-day:%' OR id LIKE 'text-characters-day:%'").get().n,0);
 await allowSharedRequest(request,env,'token');await allowSharedRequest(request,env,'token');
 await assert.rejects(allowSharedRequest(request,env,'token'),e=>e.status===429);
 t.mock.method(Date,'now',()=>now+14*61000);env.MEMBER_DAILY_REALTIME_LIMIT='1';
 await allowSharedRequest(request,env,'token');
 await assert.rejects(allowSharedRequest(request,env,'token'),e=>e.status===429);
 env.MEMBER_DAILY_TEXT_LIMIT='1';await allowSharedRequest(request,env,'text');
 await assert.rejects(allowSharedRequest(request,env,'text'),e=>e.status===429);
});

test('exhausting the one-hour trial stops new recording but still allows saving and reopening the classroom',async()=>{
 const {env,sql}=environment(),objects=new Map();
 env.BUCKET={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{async json(){return JSON.parse(objects.get(key));}}:null;},async delete(key){objects.delete(key);}};
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'exhausted-save@example.test'}),auth=cookie(account),request=req('/api/openai/realtime',undefined,auth);
 const state=await serviceState(env,await memberSession(request,env));
 sql.prepare('UPDATE plan_balances SET audio_used=? WHERE account_id=? AND scope=? AND start=?').run(3600000,account.user.id,state.balance.scope,state.balance.start);
 await assert.rejects(acquireLease(request,env),e=>e.status===402);
 const id=crypto.randomUUID(),session={id,title:'试用结束后保存的课堂',createdAt:new Date().toISOString(),status:'completed',segments:[{id:'saved-line',source:'Saved classroom',translation:'已保存课堂'}],materials:[]},path='/api/history/'+id;
 const save=new Request('https://example.test'+path,{method:'PUT',headers:{Cookie:auth}});
 assert.equal((await historyRoute(save,env,account.user,path,{session,revision:0})).revision,1);
 const reopened=await historyRoute(req(path,undefined,auth),env,account.user,path);
 assert.deepEqual(reopened.session,session);assert.equal(reopened.revision,1);
});

test('the once-only trial remains exhausted after thirty days and a fresh sign-in',async t=>{
 const {env,sql}=environment(),now=Date.now(),identity={provider:'email',subject:'trial-no-monthly-reset@example.test'};t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,identity),request=req('/api/openai/realtime',undefined,cookie(account));
 const lease=await acquireLease(request,env),row=await reserve(request,env,{kind:'audio',audioMs:3600000,lease});
 await settle(env,row,{success:true});await releaseLease(env,lease);
 assert.equal((await myUsage(request,env)).remainingMinutes,0);
 t.mock.method(Date,'now',()=>now+31*86400000);
 const again=await createVerifiedAccountSession(env,identity),next=req('/api/openai/realtime',undefined,cookie(again)),usage=await myUsage(next,env);
 assert.equal(usage.usedMinutes,60);assert.equal(usage.remainingMinutes,0);assert.equal(usage.periodEnd,null);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM plan_balances WHERE scope='trial'").get().n,1);
 await assert.rejects(acquireLease(next,env),e=>e.status===402);
});

test('returning to the trial after paid membership expires preserves its original remaining time',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'trial-paid-fallback@example.test'}),request=req('/api/openai/realtime',undefined,cookie(account));
 const lease=await acquireLease(request,env),row=await reserve(request,env,{kind:'audio',audioMs:17*60000,lease});
 await settle(env,row,{success:true});await releaseLease(env,lease);
 sql.prepare("UPDATE account_memberships SET tier='premium',expires_at=?,quota_anchor=?,updated_at=? WHERE account_id=?").run(now+86400000,now,now,account.user.id);
 assert.equal((await myUsage(request,env)).tier,'premium');
 t.mock.method(Date,'now',()=>now+2*86400000);
 const usage=await myUsage(request,env);assert.equal(usage.tier,'trial');assert.equal(usage.usedMinutes,17);assert.equal(usage.remainingMinutes,43);
 assert.equal(sql.prepare('SELECT granted_at FROM account_trials WHERE account_id=?').get(account.user.id).granted_at,now);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM plan_balances WHERE account_id=? AND scope='trial'").get(account.user.id).n,1);
});

test('ordinary translation stops exactly at thirty hours while premium translation has no time cap',async()=>{
 const {env,sql}=environment(),now=Date.now();
 for(const [tier,used] of [['regular',30*3600000-1000],['premium',1e12]]){
  const account=await createVerifiedAccountSession(env,{provider:'email',subject:tier+'-audio-boundary@example.test'}),request=req('/api/openai/realtime',undefined,cookie(account));
  sql.prepare('UPDATE account_memberships SET tier=?,expires_at=?,quota_anchor=?,updated_at=? WHERE account_id=?').run(tier,now+30*86400000,now,now,account.user.id);
  const state=await serviceState(env,await memberSession(request,env));
  sql.prepare('UPDATE plan_balances SET audio_used=? WHERE account_id=? AND scope=? AND start=?').run(used,account.user.id,tier,state.balance.start);
  const lease=await acquireLease(request,env),row=await reserve(request,env,{kind:'audio',audioMs:tier==='regular'?1000:30*3600000+1,lease});
  await settle(env,row,{success:true});
  if(tier==='regular'){
   await assert.rejects(reserve(request,env,{kind:'audio',audioMs:1,lease}),e=>e.status===402);
   assert.equal((await myUsage(request,env)).remainingMinutes,0);
  }else{
   assert.equal((await myUsage(request,env)).remainingMinutes,null);
   const more=await reserve(request,env,{kind:'audio',audioMs:1000,lease});await settle(env,more,{success:true});
  }
  await releaseLease(env,lease);
 }
});

test('same-tier renewal preserves consumed translation and summary allowances within the current period',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'same-tier-allowance@example.test'}),request=req('/api/member/login',{},cookie(account));
 await loginMember(request,env,env.MEMBER_CODE);const first=await serviceState(env,await memberSession(request,env));
 sql.prepare('UPDATE plan_balances SET audio_used=?,summaries_used=? WHERE account_id=? AND scope=? AND start=?').run(30*3600000,10,account.user.id,'regular',first.balance.start);
 t.mock.method(Date,'now',()=>now+86400000);env.MEMBER_CODE='same-tier-rotated-renewal';await loginMember(request,env,env.MEMBER_CODE);
 const after=await serviceState(env,await memberSession(request,env));assert.equal(after.balance.start,first.balance.start);
 assert.equal(after.balance.audio_used,30*3600000);assert.equal(after.balance.summaries_used,10);
 await assert.rejects(acquireLease(request,env),e=>e.status===402);
 await assert.rejects(beginSummary(request,env,{id:crypto.randomUUID(),inputHash:'new-ordinary-summary'}),e=>e.status===402);
});

test('switching from ordinary to premium and back within thirty days cannot refill ten ordinary summaries',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'tier-switch-summary@example.test'}),request=req('/api/openai/responses',{},cookie(account));
 sql.prepare('INSERT INTO account_passwords(username,account_id,password_hash,created_at) VALUES(?,?,?,?)').run('tiercycle',account.user.id,'unused-isolated-fixture-hash',now);
 let updatedAt=sql.prepare('SELECT updated_at FROM account_memberships WHERE account_id=?').get(account.user.id).updated_at;
 const change=async tier=>{const updated=await updateAdminMembership(env,{username:'tiercycle',accountId:account.user.id,tier,expiresAt:new Date(Date.now()+30*86400000).toISOString(),expectedUpdatedAt:updatedAt,reason:'Isolated tier switch test'});updatedAt=updated.updatedAt;};
 await change('regular');
 for(let i=0;i<10;i++){const job=await beginSummary(request,env,{id:crypto.randomUUID(),inputHash:'ordinary-summary-'+i});await finishSummary(env,job,{success:true,result:'Saved isolated summary'});}
 assert.equal((await myUsage(request,env)).summariesRemaining,0);
 t.mock.method(Date,'now',()=>now+86400000);await change('premium');
 assert.equal((await myUsage(request,env)).summariesRemaining,null);
 t.mock.method(Date,'now',()=>now+2*86400000);await change('regular');
 assert.equal((await myUsage(request,env)).summariesRemaining,0);
 await assert.rejects(beginSummary(request,env,{id:crypto.randomUUID(),inputHash:'ordinary-refill-attempt'}),e=>e.status===402);
});

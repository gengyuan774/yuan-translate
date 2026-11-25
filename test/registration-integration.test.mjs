import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {mintRegistration} from './registration-fixture.mjs';
import {handle} from '../src/worker.js';
import {hashPassword} from '../src/password-server.js';
import {newPasswordError} from '../src/password-policy.js';
import {digest} from '../src/security-common.js';

const password='Sunlight across the quiet classroom 482!';
const noExternal=()=>{throw Error('No external service is authorized in registration integration tests');};
function fixture(){
 const f=environment(),batch=f.env.DB.batch.bind(f.env.DB);f.env.TRIAL_CLAIM_SECRET='synthetic-independent-stable-trial-claim-secret';let previous=Promise.resolve();
 f.env.DB.batch=items=>{const run=previous.then(()=>batch(items));previous=run.catch(()=>{});return run;};
 // This header is supplied by the synthetic trusted edge in a local test. These
 // tests do not establish whether a deployed proxy overwrites client headers.
 const headers={'CF-Connecting-IP':'198.51.100.17'};
 const call=(path,body,cookie='',upstream=noExternal)=>handle(req(path,body,cookie,headers),upstream,f.env);
 const register=async(username,secret=password)=>{const challenge=await mintRegistration(f.env,username,{headers});return call('/api/account/register/password',{username,password:secret,registration:challenge.registration},challenge.cookie);};
 return {...f,headers,call,register};
}
async function success(response){assert.equal(response.status,200,await response.clone().text());return response.json();}
const sessionCookie=response=>response.headers.get('Set-Cookie')?.split(';')[0];

test('the complete HTTP registration chain grants a secure session, one trial and repeat login without refilling it',async()=>{
 const shortPassword='Pine482k';
 const f=fixture(),response=await f.register('HTTPChain',shortPassword),data=await success(response),cookie=sessionCookie(response);
 assert.match(response.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);assert.equal(data.user.label,'httpchain');assert.equal(data.user.trial.remainingMinutes,60);
 assert.equal((await success(await f.call('/api/account',undefined,cookie))).user.id,data.user.id);
 const usage=await success(await f.call('/api/account/usage',undefined,cookie));assert.equal(usage.tier,'trial');assert.equal(usage.remainingMinutes,60);
 await success(await f.call('/api/account/logout',{},cookie));assert.equal((await success(await f.call('/api/account',undefined,cookie))).user,null);
 const signedIn=await success(await f.call('/api/account/login/password',{username:'httpchain',password:shortPassword}));assert.equal(signedIn.user.id,data.user.id);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM registration_challenges WHERE claimed_at IS NOT NULL').get().n,1);
});

test('simultaneous HTTP replays of one solved challenge create one account and one trial',async()=>{
 const f=fixture(),username='racechain',challenge=await mintRegistration(f.env,username,{headers:f.headers}),body={username,password,registration:challenge.registration};
 const responses=await Promise.all([f.call('/api/account/register/password',body,challenge.cookie),f.call('/api/account/register/password',body,challenge.cookie)]);
 assert.deepEqual(responses.map(r=>r.status).sort((a,b)=>a-b),[200,400]);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_passwords').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 const replay=await f.call('/api/account/register/password',body,challenge.cookie);assert.equal(replay.status,400);
});

test('completing account deletion and registering the same name again never grants a second trial',async()=>{
 const f=fixture();f.env.BUCKET={list:async()=>({objects:[]}),delete:async()=>{}};
 const first=await f.register('deletedchain'),old=await success(first),cookie=sessionCookie(first);
 const receipt=await success(await f.call('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'},cookie));
 assert.equal((await success(await f.call('/api/account',undefined,cookie))).user,null);
 f.sql.prepare('UPDATE deletion_jobs SET created_at=? WHERE id=?').run(Date.now()-90001,receipt.jobId);
 assert.equal((await success(await f.call('/api/account/deletion/resume',receipt))).status,'completed');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 f.env.MEMBER_SESSION_SECRET='synthetic-rotated-session-secret';f.env.OPENAI_API_KEY='synthetic-rotated-api-key';
 const second=await f.register('DELETEDCHAIN'),current=await success(second);assert.notEqual(current.user.id,old.user.id);assert.equal(current.user.trial.eligible,false);assert.equal(current.user.trial.remainingMinutes,0);
 const status=await success(await f.call('/api/member/status',undefined,sessionCookie(second)));assert.equal(status.member,false);assert.equal(status.trial.eligible,false);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 assert.doesNotMatch(JSON.stringify(f.sql.prepare('SELECT * FROM trial_claims').all()),/deletedchain/);
});

test('a previously granted legacy trial is preserved as a marker during deletion before same-name registration',async()=>{
 const f=fixture(),username='legacytrial',id='legacy-trial-before-marker',createdAt=Date.now()-86400000;f.env.BUCKET={list:async()=>({objects:[]}),delete:async()=>{}};
 f.sql.prepare('INSERT INTO accounts(id,provider,subject_hash,label,created_at) VALUES(?,?,?,?,?)').run(id,'password',await digest('password:'+username),username,createdAt);
 f.sql.prepare('INSERT INTO account_passwords(username,account_id,password_hash,created_at) VALUES(?,?,?,?)').run(username,id,await hashPassword(password),createdAt);
 f.sql.prepare('INSERT INTO account_trials(account_id,granted_at) VALUES(?,?)').run(id,createdAt);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,0);
 const login=await f.call('/api/account/login/password',{username,password}),existing=await success(login),cookie=sessionCookie(login);assert.equal(existing.user.trial.eligible,true);
 const receipt=await success(await f.call('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'},cookie));
 f.sql.prepare('UPDATE deletion_jobs SET created_at=? WHERE id=?').run(Date.now()-90001,receipt.jobId);
 assert.equal((await success(await f.call('/api/account/deletion/resume',receipt))).status,'completed');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 const registered=await success(await f.register(username));assert.notEqual(registered.user.id,id);assert.equal(registered.user.trial.eligible,false);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,0);
});

test('legacy eight-character passwords still log in while registration enforces the new password rules',async()=>{
 const f=fixture(),legacy='oldpassw';
 f.sql.prepare('INSERT INTO accounts(id,provider,subject_hash,label,created_at) VALUES(?,?,?,?,?)').run('legacy-eight','password','legacy-fixture','legacyuser',1);
 f.sql.prepare('INSERT INTO account_passwords(username,account_id,password_hash,created_at) VALUES(?,?,?,?)').run('legacyuser','legacy-eight',await hashPassword(legacy),1);
 const signedIn=await success(await f.call('/api/account/login/password',{username:'legacyuser',password:legacy}));assert.equal(signedIn.user.id,'legacy-eight');assert.equal(signedIn.user.trial.eligible,false);
 const username='weakchain',challenge=await mintRegistration(f.env,username,{headers:f.headers});
 for(const weak of ['Short7!',legacy,'passwordpassword','abcd'.repeat(4)]){
  const rejected=await f.call('/api/account/register/password',{username,password:weak,registration:challenge.registration},challenge.cookie);assert.equal(rejected.status,400);assert.equal((await rejected.json()).error.message,newPasswordError(weak,username));
 }
 const named=await f.register('complicated_name','complicated_name');assert.equal(named.status,400);assert.match((await named.json()).error.message,/账号名/);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
});

test('registration, password changes and email recovery apply the same new-password policy',async t=>{
 const f=fixture(),username='policychain',registered=await f.register(username),user=await success(registered),cookie=sessionCookie(registered),weak='abcdefgh';
 const expected=newPasswordError(weak,username),before=f.sql.prepare('SELECT password_hash FROM account_passwords WHERE account_id=?').get(user.user.id).password_hash;
 assert.match(expected,/至少包含两类/);
 const rejectedRegistration=await f.register('newpolicychain',weak);assert.equal(rejectedRegistration.status,400);assert.equal((await rejectedRegistration.json()).error.message,expected);
 const changed=await f.call('/api/account/password/change',{currentPassword:password,newPassword:weak},cookie);assert.equal(changed.status,400);assert.equal((await changed.json()).error.message,expected);
 Object.assign(f.env,{RECOVERY_EMAIL_PROVIDER:'resend',RESEND_API_KEY:'synthetic-email-test-only',RECOVERY_EMAIL_FROM:'test@example.test'});let code;
 const mail=async(url,init)=>{assert.equal(url,'https://api.resend.com/emails');code=JSON.parse(init.body).text.match(/\d{6}/)[0];return Response.json({id:'local-mail-mock'});};
 const email='policy@example.test',bind=await success(await f.call('/api/account/recovery/bind/send',{currentPassword:password,email},cookie,mail));
 await success(await f.call('/api/account/recovery/bind/verify',{challengeId:bind.challengeId,code},cookie));
 let now=Date.now()+61000;t.mock.method(Date,'now',()=>now);
 const reset=await success(await f.call('/api/account/recovery/reset/send',{username,email},'',mail));
 const recovered=await f.call('/api/account/recovery/reset/verify',{challengeId:reset.challengeId,code,newPassword:weak});assert.equal(recovered.status,400);assert.equal((await recovered.json()).error.message,expected);
 assert.equal(f.sql.prepare('SELECT password_hash FROM account_passwords WHERE account_id=?').get(user.user.id).password_hash,before);
 assert.ok(f.sql.prepare('SELECT id FROM recovery_challenges WHERE id=?').get(reset.challengeId),'A weak new password must leave the valid recovery code usable');
 const next='42!83#17';
 await success(await f.call('/api/account/recovery/reset/verify',{challengeId:reset.challengeId,code,newPassword:next}));
 assert.equal((await success(await f.call('/api/account',undefined,cookie))).user,null);
 assert.equal((await success(await f.call('/api/account/login/password',{username,password:next}))).user.id,user.user.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {environment} from './server-fixture.mjs';
import {handle} from '../src/worker.js';
import {hashPassword} from '../src/password-server.js';
import {issueAccountSession,accountUser} from '../src/account-server.js';
import {digest} from '../src/security-common.js';
const password='Original-password-123',next='Lake#Day',token='ef'.repeat(32);
function request(path,body,cookie='',headers={}){return new Request('https://example.test'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':'127.0.0.1',...headers},body:body?JSON.stringify(body):undefined});}
async function fixture(){
 const f=environment(),objects=new Map();f.env.MEMBER_ADMIN_TOKEN_SHA256=await digest(token);
 f.env.BUCKET={async list({prefix,limit}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(key=>({key}))};},async get(key){return objects.has(key)?{async json(){return JSON.parse(objects.get(key));}}:null;},async put(key,value){objects.set(key,value);},async delete(key){objects.delete(key);}};
 const pw=await hashPassword(password);
 for(const [id,name] of [['owner','testowner'],['other','testother']]){
  f.sql.prepare('INSERT INTO accounts (id,provider,subject_hash,label,created_at) VALUES (?,?,?,?,?)').run(id,'password',id,name,1);
  f.sql.prepare('INSERT INTO account_passwords (username,account_id,password_hash,created_at) VALUES (?,?,?,?)').run(name,id,pw,1);
 }
 const a=await issueAccountSession(f.env,{id:'owner',provider:'password',label:'testowner'}),b=await issueAccountSession(f.env,{id:'other',provider:'password',label:'testother'});
 return {...f,objects,a:a.cookie.split(';')[0],b:b.cookie.split(';')[0],async call(path,body,cookie=a.cookie.split(';')[0],upstream){return handle(request(path,body,cookie),upstream,f.env);}};
}
test('changing password revokes all sessions, rejects stale login issuance and preserves another user',async()=>{
 const f=await fixture(),second=await issueAccountSession(f.env,{id:'owner',provider:'password',label:'testowner'});
 assert.equal((await f.call('/api/account/password/change',{currentPassword:'incorrect',newPassword:next})).status,401);
 assert.equal((await f.call('/api/account/password/change',{currentPassword:password,newPassword:next})).status,200);
 for(const cookie of [f.a,second.cookie.split(';')[0]])assert.equal(await accountUser(request('/api/account',null,cookie),f.env),null);
 assert.ok(await accountUser(request('/api/account',null,f.b),f.env));
 await assert.rejects(()=>issueAccountSession(f.env,{id:'owner',provider:'password',label:'testowner',securityVersion:0}),/已变化/);
 assert.equal((await f.call('/api/account/login/password',{username:'testowner',password})).status,401);
 assert.equal((await f.call('/api/account/login/password',{username:'testowner',password:next})).status,200);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM security_audit WHERE action='password_changed'").get().n,1);
});
test('password mutation rolls back fully when database update fails',async()=>{
 const f=await fixture();f.sql.exec("CREATE TRIGGER fail_password BEFORE UPDATE ON account_passwords BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await f.call('/api/account/password/change',{currentPassword:password,newPassword:next})).status,503);
 assert.ok(await accountUser(request('/api/account',null,f.a),f.env));
 assert.equal(f.sql.prepare("SELECT count(*) n FROM security_audit WHERE action='password_changed'").get().n,0);
});
async function enableEmail(f){f.env.RECOVERY_EMAIL_PROVIDER='resend';f.env.RESEND_API_KEY='fake-resend-test-key';f.env.RECOVERY_EMAIL_FROM='test@example.test';let code;
 f.mail=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');const data=JSON.parse(options.body);code=data.text.match(/\d{6}/)[0];return Response.json({id:'test-mail'});};f.code=()=>code;
}
test('recovery stays disabled without service, never trusts unverified email',async()=>{
 const f=await fixture();assert.deepEqual(await (await f.call('/api/account/recovery/options')).json(),{email:false});
 assert.equal((await f.call('/api/account/recovery/reset/send',{username:'testowner',email:'a@example.test'})).status,503);
 await enableEmail(f);let sent=0;
 const r=await f.call('/api/account/recovery/reset/send',{username:'testowner',email:'unverified@example.test'},'',async()=>{sent++;throw new Error();});
 assert.equal(r.status,200);assert.equal(sent,0);const body=await r.json();assert.ok(body.challengeId);
 assert.equal((await f.call('/api/account/recovery/reset/verify',{challengeId:body.challengeId,code:'123456',newPassword:next},'')).status,400);
});
test('verified email binds to owner, resets password once and invalidates sessions',async()=>{
 const f=await fixture();await enableEmail(f);
 let r=await f.call('/api/account/recovery/bind/send',{currentPassword:password,email:'a@example.test'},f.a,f.mail);assert.equal(r.status,200);let ch=await r.json(),code=f.code();
 assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code},f.b)).status,400);
 assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code})).status,200);
 assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code})).status,400);
 f.sql.exec('DELETE FROM usage_buckets');
 r=await f.call('/api/account/recovery/reset/send',{username:'testowner',email:'a@example.test'},'',f.mail);ch=await r.json();code=f.code();
 const wrong=code==='000000'?'111111':'000000';assert.equal((await f.call('/api/account/recovery/reset/verify',{challengeId:ch.challengeId,code:wrong,newPassword:next},'')).status,400);
 assert.equal((await f.call('/api/account/recovery/reset/verify',{challengeId:ch.challengeId,code,newPassword:next},'')).status,200);
 assert.equal((await f.call('/api/account/recovery/reset/verify',{challengeId:ch.challengeId,code,newPassword:password},'')).status,400);
 assert.equal(await accountUser(request('/api/account',null,f.a),f.env),null);
 assert.equal((await f.call('/api/account/login/password',{username:'testowner',password:next},'')).status,200);
});
test('OTP expiration, attempt limit, resend cooldown and provider failure fail closed',async()=>{
 const f=await fixture();await enableEmail(f);let r=await f.call('/api/account/recovery/bind/send',{currentPassword:password,email:'a@example.test'},f.a,f.mail),ch=await r.json();
 assert.equal((await f.call('/api/account/recovery/bind/send',{currentPassword:password,email:'a@example.test'},f.a,f.mail)).status,429);
 const wrong=f.code()==='000000'?'111111':'000000';for(let i=0;i<5;i++)assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code:wrong})).status,400);
 assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code:f.code()})).status,400);
 f.sql.exec('DELETE FROM usage_buckets');r=await f.call('/api/account/recovery/bind/send',{currentPassword:password,email:'b@example.test'},f.a,f.mail);ch=await r.json();f.sql.exec('UPDATE recovery_challenges SET expires_at=1');
 assert.equal((await f.call('/api/account/recovery/bind/verify',{challengeId:ch.challengeId,code:f.code()})).status,400);
 r=await f.call('/api/account/recovery/bind/send',{currentPassword:password,email:'fail@example.test'},f.a,async()=>new Response('failed',{status:500}));assert.equal(r.status,503);assert.equal(f.sql.prepare("SELECT count(*) n FROM recovery_challenges WHERE email='fail@example.test'").get().n,0);
});
test('export includes owned cloud data only and omits credential material',async()=>{
 const f=await fixture();for(const id of ['owner','other']){const key=`accounts/${id}/classes/test.json`;f.objects.set(key,JSON.stringify({title:id+' notes'}));f.sql.prepare('INSERT INTO account_classes VALUES (?,?,?,?,?,?,?,?,?)').run(id,id,'Title','2026-01-01','completed',0,0,key,1);}
 const r=await f.call('/api/account/data/export',{currentPassword:password});assert.equal(r.status,200);const text=await r.text();assert.match(text,/owner notes/);assert.doesNotMatch(text,/other notes|password_hash|token_hash|scrypt|fake-resend|sk-test/);assert.match(text,/"type":"complete"/);
 assert.equal((await f.call('/api/account/data/export',{currentPassword:'bad'})).status,401);
});
test('deletion blocks access immediately, retries failed object removal, removes only own data',async()=>{
 const f=await fixture();f.objects.set('accounts/owner/classes/old.json','{}');f.objects.set('accounts/other/classes/keep.json','{}');
 let r=await f.call('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'});assert.equal(r.status,200);const receipt=await r.json();
 assert.equal(await accountUser(request('/api/account',null,f.a),f.env),null);
 assert.equal((await f.call('/api/account/deletion/resume',{...receipt,receipt:'wrong'},'')).status,404);
 assert.equal((await (await f.call('/api/account/deletion/resume',receipt,'')).json()).status,'pending');
 f.sql.exec('UPDATE deletion_jobs SET created_at=1');const remove=f.env.BUCKET.delete;f.env.BUCKET.delete=async()=>{throw new Error('storage unavailable');};
 assert.equal((await f.call('/api/account/deletion/resume',receipt,'')).status,503);assert.ok(f.sql.prepare("SELECT id FROM accounts WHERE id='owner'").get());f.env.BUCKET.delete=remove;
 await f.call('/api/account/deletion/resume',receipt,'');r=await f.call('/api/account/deletion/resume',receipt,'');assert.equal((await r.json()).status,'completed');
 assert.equal(f.sql.prepare("SELECT id FROM accounts WHERE id='owner'").get(),undefined);assert.ok(f.sql.prepare("SELECT id FROM accounts WHERE id='other'").get());assert.ok(f.objects.has('accounts/other/classes/keep.json'));assert.equal(f.objects.has('accounts/owner/classes/old.json'),false);
 assert.equal((await (await f.call('/api/account/deletion/resume',receipt,'')).json()).status,'completed');
});
test('admin blocking revokes sessions; ordinary users cannot act; refund note is audit only',async()=>{
 const f=await fixture(),headers={Authorization:'Bearer '+token};const act=data=>handle(request('/api/admin/security',data,'',headers),undefined,f.env);
 assert.equal((await f.call('/api/admin/security',{username:'testowner',accountId:'owner',action:'block',expectedVersion:0,reason:'test'})).status,401);
 assert.equal((await act({username:'testowner',accountId:'owner',action:'block',expectedVersion:0,reason:'test'})).status,200);
 assert.equal(await accountUser(request('/api/account',null,f.a),f.env),null);
 assert.equal((await f.call('/api/account/login/password',{username:'testowner',password},'')).status,403);
 assert.equal((await act({username:'testowner',accountId:'owner',action:'unblock',expectedVersion:1,reason:'test'})).status,200);
 const before=f.sql.prepare("SELECT * FROM account_memberships WHERE account_id='owner'").get();
 const r=await act({username:'testowner',accountId:'owner',action:'refund_note',expectedVersion:2,reason:'manual review',reference:'external-123',outcome:'requested'});assert.equal(r.status,200);assert.equal((await r.json()).recordOnly,true);
 assert.deepEqual(f.sql.prepare("SELECT * FROM account_memberships WHERE account_id='owner'").get(),before);assert.equal(f.sql.prepare("SELECT count(*) n FROM security_audit WHERE actor='admin'").get().n,3);
});
test('sensitive actions reject cross-origin requests and missing authentication; unavailable login options absent',async()=>{
 const f=await fixture();for(const path of ['/api/account/password/change','/api/account/data/export','/api/account/delete']){assert.equal((await handle(request(path,{currentPassword:password},f.a,{Origin:'https://evil.test'}),undefined,f.env)).status,403);}
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/login-phone-tab|login-email-tab|login-wechat-tab|微信登录待接入|短信服务待接入/);assert.match(html,/id="recovery-open"[^>]*hidden/);
});

test('unauthenticated or wrong-password email binding cannot consume delivery quotas or send mail',async()=>{
 const f=await fixture();await enableEmail(f);let sent=0;const mail=async(...args)=>{sent++;return f.mail(...args);};
 const data={currentPassword:'incorrect-password',email:'a@example.test'};
 assert.equal((await f.call('/api/account/recovery/bind/send',data,'',mail)).status,401);
 assert.equal((await f.call('/api/account/recovery/bind/send',data,f.a,mail)).status,401);
 assert.equal(sent,0);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM usage_buckets WHERE id LIKE 'email-%' OR id LIKE 'security:email-send:%'").get().n,0);
 assert.equal((await f.call('/api/account/recovery/bind/send',{...data,currentPassword:password},f.a,mail)).status,200);assert.equal(sent,1);
});
test('successful exports audit completion; interrupted exports cannot claim completion',async()=>{
 const f=await fixture();
 let r=await f.call('/api/account/data/export',{currentPassword:password});assert.match(await r.text(),/"type":"complete"/);
 const count=action=>f.sql.prepare('SELECT count(*) n FROM security_audit WHERE action=?').get(action).n;
 assert.equal(count('personal_data_export_requested'),1);assert.equal(count('personal_data_export_completed'),1);
 f.sql.prepare('INSERT INTO account_classes VALUES (?,?,?,?,?,?,?,?,?)').run('owner','missing-object','Unavailable','2026-10-12','completed',0,0,'accounts/owner/classes/unavailable.json',1);
 r=await f.call('/api/account/data/export',{currentPassword:password});await assert.rejects(()=>r.text());
 assert.equal(count('personal_data_export_requested'),2);assert.equal(count('personal_data_export_completed'),1);
});
test('deletion completion is audited once and strips personal details from retained events',async()=>{
 const f=await fixture();const r=await f.call('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'}),receipt=await r.json();
 f.sql.exec('UPDATE deletion_jobs SET created_at=1');
 assert.equal((await (await f.call('/api/account/deletion/resume',receipt,'')).json()).status,'completed');
 assert.equal((await (await f.call('/api/account/deletion/resume',receipt,'')).json()).status,'completed');
 const events=f.sql.prepare('SELECT * FROM security_audit WHERE subject=?').all(await digest('audit:owner'));
 assert.equal(events.filter(e=>e.action==='deletion_completed').length,1);assert.ok(events.every(e=>e.details==='{}'));
 assert.equal(f.sql.prepare("SELECT count(*) n FROM accounts WHERE id='owner'").get().n,0);
});
test('refund audit rejects a version change occurring after the initial admin read',async()=>{
 const f=await fixture(),prepare=f.env.DB.prepare.bind(f.env.DB);
 f.env.DB.prepare=query=>{
  if(query.startsWith('INSERT INTO security_audit')&&query.includes("'refund_note'"))f.sql.prepare("UPDATE account_security SET version=version+1 WHERE account_id='owner'").run();
  return prepare(query);
 };
 const r=await handle(request('/api/admin/security',{username:'testowner',accountId:'owner',action:'refund_note',expectedVersion:0,reason:'manual review',reference:'external-123',outcome:'requested'},'',{Authorization:'Bearer '+token}),undefined,f.env);
 assert.equal(r.status,409);assert.equal(f.sql.prepare("SELECT count(*) n FROM security_audit WHERE action='refund_note'").get().n,0);
});

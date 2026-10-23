import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {environment} from './server-fixture.mjs';
import {handle} from '../src/worker.js';
const token='ab'.repeat(32),end='2099-12-31T15:59:59.999Z';
function fixture(){
 const f=environment();f.env.MEMBER_ADMIN_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
 for(const [id,name] of [['one','yanranzhao'],['two','otheruser']]){
  f.sql.prepare('INSERT INTO accounts (id,provider,subject_hash,label,phone_e164,created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(id,'password',id,name,1);
  f.sql.prepare('INSERT INTO account_passwords (username,account_id,password_hash,created_at) VALUES (?, ?, ?, ?)').run(name,id,'unused-test-hash',1);
  f.sql.prepare('INSERT INTO account_memberships (account_id,tier,expires_at,updated_at) VALUES (?, ?, ?, ?)').run(id,'regular',Date.now()+86400000,10);
 }
 return f;
}
const payload=()=>({username:'yanranzhao',accountId:'one',tier:'regular',expiresAt:end,expectedUpdatedAt:10,reason:'Owner requested extension'});
function request(body,auth=token,headers={}){return new Request('https://example.test/api/admin/membership?username=yanranzhao',{method:body?'PUT':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{}),...headers},body:body?JSON.stringify(body):undefined});}
test('admin auth rejects guest, member code, spoofed identity and disabled configuration without writes',async()=>{
 const {env,sql}=fixture();
 for(const auth of [null,'test-member-code','cd'.repeat(32)]){
  const r=await handle(request(payload(),auth,{'X-Account-ID':'one','X-Access-Mode':'member',Cookie:'account=anything'}),undefined,env);assert.equal(r.status,401);
 }
 delete env.MEMBER_ADMIN_TOKEN_SHA256;assert.equal((await handle(request(payload()),undefined,env)).status,503);
 assert.equal(sql.prepare('SELECT count(*) n FROM membership_admin_audit').get().n,0);
 assert.equal(sql.prepare('SELECT updated_at FROM account_memberships WHERE account_id=?').get('one').updated_at,10);
});
test('admin reads no credentials, updates exactly one account and records old/new values atomically',async()=>{
 const {env,sql}=fixture(),other=sql.prepare('SELECT * FROM account_memberships WHERE account_id=?').get('two');
 const read=await handle(request(),undefined,env);assert.equal(read.status,200);assert.equal(read.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(Object.keys(await read.json()).sort(),['accountId','expiresAt','tier','updatedAt','username']);
 const r=await handle(request(payload()),undefined,env);assert.equal(r.status,200);const result=await r.json();
 assert.equal(result.expiresAt,Date.parse(end));assert.equal(result.tier,'regular');
 assert.deepEqual(sql.prepare('SELECT * FROM account_memberships WHERE account_id=?').get('two'),other);
 const audit=sql.prepare('SELECT * FROM membership_admin_audit').get();assert.equal(audit.account_id,'one');assert.equal(audit.expires_at,Date.parse(end));assert.equal(audit.previous_tier,'regular');
 assert.equal((await handle(request(payload()),undefined,env)).status,409);
 assert.equal(sql.prepare('SELECT count(*) n FROM membership_admin_audit').get().n,1);
});
test('admin validates identity, expiry, fields and cross-site requests',async()=>{
 const {env,sql}=fixture();
 for(const extra of [{tier:'gold'},{expiresAt:'tomorrow'},{expiresAt:'2099-02-31T00:00:00.000Z'},{expiresAt:'2000-01-01T00:00:00.000Z'},{tier:'none',expiresAt:end},{reason:''},{username:"x' OR 1=1--"},{unexpected:1}])assert.equal((await handle(request({...payload(),...extra}),undefined,env)).status,400);
 assert.equal((await handle(request({...payload(),accountId:'two'}),undefined,env)).status,409);
 assert.equal((await handle(request(payload(),token,{Origin:'https://evil.test'}),undefined,env)).status,403);
 assert.equal(sql.prepare('SELECT count(*) n FROM membership_admin_audit').get().n,0);
});
test('admin prevents lost concurrent updates and rolls back audit if update fails',async()=>{
 const {env,sql}=fixture(),batch=env.DB.batch.bind(env.DB);
 env.DB.batch=async items=>{sql.prepare('UPDATE account_memberships SET updated_at=11 WHERE account_id=?').run('one');return batch(items);};
 assert.equal((await handle(request(payload()),undefined,env)).status,409);
 assert.equal(sql.prepare('SELECT count(*) n FROM membership_admin_audit').get().n,0);
 env.DB.batch=batch;sql.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON account_memberships BEGIN SELECT RAISE(ABORT, 'test failure'); END");
 assert.equal((await handle(request({...payload(),expectedUpdatedAt:11}),undefined,env)).status,503);
 assert.equal(sql.prepare('SELECT count(*) n FROM membership_admin_audit').get().n,0);
});
test('admin can revoke membership or set premium without changing redemption records',async()=>{
 const {env,sql}=fixture();
 let r=await handle(request({...payload(),tier:'premium'}),undefined,env);assert.equal(r.status,200);let row=await r.json();
 r=await handle(request({...payload(),tier:'none',expiresAt:null,expectedUpdatedAt:row.updatedAt}),undefined,env);assert.equal(r.status,200);row=await r.json();assert.equal(row.tier,'none');assert.equal(row.expiresAt,null);
 assert.equal(sql.prepare('SELECT count(*) n FROM member_redemptions').get().n,0);
});

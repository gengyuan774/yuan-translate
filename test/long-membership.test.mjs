import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/worker.js';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {environment,req} from './server-fixture.mjs';
import {digest} from '../src/security-common.js';
const code='ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUV',expiry=Date.parse('2099-12-31T23:59:59.999+08:00');
const noExternal=()=>{throw new Error('No external calls');};
async function fixture(){
 const f=environment();f.env.MEMBER_LONG_CODE_SHA256=await digest(code);
 f.user=async name=>{const result=await createVerifiedAccountSession(f.env,{provider:'email',subject:name+'@example.test',label:name});return {id:result.user.id,cookie:result.cookie.split(';')[0]};};
 f.redeem=(who,value=code,extra={})=>handle(req('/api/member/login',{code:value,...extra},who?.cookie||'',{'CF-Connecting-IP':'192.0.2.1'}),noExternal,f.env);return f;
}
test('shared long code grants premium through 2099 once per account, without exposing code or hash',async()=>{
 const f=await fixture(),a=await f.user('a'),b=await f.user('b');
 for(const user of [a,b]){const r=await f.redeem(user);assert.equal(r.status,200);const text=await r.text(),data=JSON.parse(text);assert.equal(data.membership.tier,'premium');assert.equal(data.membership.expiresAt,expiry);assert.ok(!text.includes(code)&&!text.includes(f.env.MEMBER_LONG_CODE_SHA256));}
 assert.equal((await f.redeem(a)).status,409);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM member_redemptions').get().n,2);
 const audits=f.sql.prepare("SELECT * FROM security_audit WHERE action='long_membership_redeemed'").all();assert.equal(audits.length,2);assert.ok(!JSON.stringify(audits).includes(code));
 assert.equal(JSON.parse(audits[0].details).tier,'premium');
});
test('concurrent redemption grants only once, cannot restore revoked rights or change expiry on retry',async()=>{
 const f=await fixture(),a=await f.user('parallel');
 const results=await Promise.all([f.redeem(a),f.redeem(a),f.redeem(a)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409,409]);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM member_redemptions').get().n,1);
 f.sql.prepare("UPDATE account_memberships SET tier='none',expires_at=NULL WHERE account_id=?").run(a.id);
 assert.equal((await f.redeem(a)).status,409);assert.equal(f.sql.prepare('SELECT tier FROM account_memberships WHERE account_id=?').get(a.id).tier,'none');
});
test('existing ordinary membership upgrades; ordinary code cannot downgrade gold or extend its expiry',async()=>{
 const f=await fixture(),a=await f.user('upgrade');assert.equal((await f.redeem(a,'test-member-code')).status,200);
 const r=await f.redeem(a);assert.equal(r.status,200);assert.equal((await r.json()).membership.expiresAt,expiry);
 const after=await (await f.redeem(a,'test-member-code')).json();assert.equal(after.membership.tier,'premium');assert.equal(after.membership.expiresAt,expiry);
});
test('wrong, lowercase and forged client fields cannot unlock gold; login, bans and CSRF still apply',async()=>{
 const f=await fixture(),a=await f.user('auth');assert.equal((await f.redeem(null)).status,401);
 for(const value of [code.toLowerCase(),'wrong',f.env.MEMBER_LONG_CODE_SHA256])assert.equal((await f.redeem(a,value,{tier:'premium',expiresAt:expiry})).status,401);
 assert.equal((await handle(req('/api/member/login',{code},a.cookie,{Origin:'https://evil.test'}),noExternal,f.env)).status,403);
 f.sql.prepare("UPDATE account_security SET status='banned' WHERE account_id=?").run(a.id);assert.equal((await f.redeem(a)).status,401);
});
test('redemption writes and audit roll back together on database failure',async()=>{
 const f=await fixture(),a=await f.user('rollback');f.sql.exec("CREATE TRIGGER fail_redemption BEFORE INSERT ON member_redemptions BEGIN SELECT RAISE(ABORT,'test failure'); END");
 assert.equal((await f.redeem(a)).status,503);assert.equal(f.sql.prepare('SELECT tier FROM account_memberships WHERE account_id=?').get(a.id).tier,'none');assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM security_audit WHERE action='long_membership_redeemed'").get().n,0);
});
test('long code works alone, expires at the fixed boundary and respects account attempt limits',async t=>{
 const f=await fixture(),a=await f.user('only');delete f.env.MEMBER_CODE;
 assert.equal((await f.redeem(a)).status,200);
 t.mock.method(Date,'now',()=>expiry);const b=await f.user('expiry');assert.equal((await f.redeem(b)).status,409);
 t.mock.restoreAll();const c=await f.user('attempts');for(let i=0;i<15;i++)assert.equal((await f.redeem(c,'wrong')).status,401);assert.equal((await f.redeem(c)).status,429);
});
test('IP limit prevents bypass through many accounts',async()=>{
 const f=await fixture();for(let i=0;i<4;i++){const a=await f.user('ip-'+i);for(let j=0;j<15;j++)assert.equal((await f.redeem(a,'wrong')).status,401);}
 const next=await f.user('ip-next');assert.equal((await f.redeem(next)).status,429);
});

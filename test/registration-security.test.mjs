import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {environment,req} from './server-fixture.mjs';
import {createRegistrationChallenge,consumeRegistrationChallenge,authRate} from '../src/registration-security.js';
import {passwordAccount} from '../src/password-server.js';

const password='Independent secure audit passphrase 2026';
const ip='192.0.2.10';
const request=(cookie='',network=ip)=>req('/api/account/register/password',{},cookie,network===null?{}:{'CF-Connecting-IP':network});
const valid=(id,nonce,solution)=>{const hash=createHash('sha256').update(`${id}:${nonce}:${solution}`).digest();return hash[0]===0&&hash[1]===0&&(hash[2]&0xc0)===0;};
function solve(data){for(let solution=0;solution<=0xffffffff;solution++)if(valid(data.challengeId,data.nonce,solution))return solution;throw Error('No solution found');}
async function mint(f,username,network=ip,{age=true}={}){
 const result=await createRegistrationChallenge(request('',network),f.env,{username}),cookie=result.cookie.split(';')[0],registration={challengeId:result.data.challengeId,solution:solve(result.data)};
 if(age)f.sql.prepare('UPDATE registration_challenges SET created_at=created_at-1000 WHERE id=?').run(result.data.challengeId);
 return {...result,cookie,registration,request:request(cookie,network),username};
}

test('real signup challenges use eighteen proof bits, secure browser cookies, hashed bindings and one-time consumption',async()=>{
 const f=environment(),issued=await createRegistrationChallenge(request(),f.env,{username:' Test.User '}),data=issued.data;
 assert.equal(data.difficulty,18);assert.equal(data.minWaitMs,750);assert.equal(data.expiresAt-f.sql.prepare('SELECT created_at FROM registration_challenges').get().created_at,300000);
 assert.match(issued.cookie,/^__Host-classroom_signup=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/);
 const stored=f.sql.prepare('SELECT * FROM registration_challenges').get();
 for(const field of ['network_hash','username_hash','browser_hash'])assert.match(stored[field],/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(stored).includes(ip)&&!JSON.stringify(stored).includes('test.user'));
 f.sql.prepare('UPDATE registration_challenges SET created_at=created_at-1000 WHERE id=?').run(data.challengeId);
 const registration={challengeId:data.challengeId,solution:solve(data)},bound=request(issued.cookie.split(';')[0]);
 await consumeRegistrationChallenge(bound,f.env,'TEST.USER',registration);
 await assert.rejects(consumeRegistrationChallenge(bound,f.env,'test.user',registration),e=>e.status===400);
 assert.ok(f.sql.prepare('SELECT claimed_at FROM registration_challenges').get().claimed_at);
});

test('challenge proofs are bound to normalized username, browser cookie and client network',async()=>{
 const f=environment(),challenge=await mint(f,'bounduser');
 for(const [bound,name] of [[challenge.request,'differentuser'],[request(challenge.cookie,'192.0.2.11'),'bounduser'],[request('__Host-classroom_signup='+'a'.repeat(64)),'bounduser'],[request(),'bounduser']]){
  await assert.rejects(consumeRegistrationChallenge(bound,f.env,name,challenge.registration),e=>e.status===400);
  assert.equal(f.sql.prepare('SELECT claimed_at FROM registration_challenges').get().claimed_at,null);
 }
 await consumeRegistrationChallenge(challenge.request,f.env,' BoundUser ',challenge.registration);
});

test('incorrect, malformed, early and expired proof attempts consume the bound challenge and need a fresh one',async t=>{
 const f=environment(),wrong=await mint(f,'wrongproof');let incorrect=0;while(valid(wrong.data.challengeId,wrong.data.nonce,incorrect))incorrect++;
 await assert.rejects(consumeRegistrationChallenge(wrong.request,f.env,wrong.username,{...wrong.registration,solution:incorrect}),e=>e.status===400);
 await assert.rejects(consumeRegistrationChallenge(wrong.request,f.env,wrong.username,wrong.registration),e=>e.status===400);
 const malformed=await mint(f,'malformedproof');
 await assert.rejects(consumeRegistrationChallenge(malformed.request,f.env,malformed.username,{...malformed.registration,solution:0x100000000}),e=>e.status===400);
 const now=Date.now();t.mock.method(Date,'now',()=>now);
 const early=await mint(f,'earlyproof',ip,{age:false});
 t.mock.method(Date,'now',()=>now+749);
 await assert.rejects(consumeRegistrationChallenge(early.request,f.env,early.username,early.registration),e=>e.status===400);
 t.mock.method(Date,'now',()=>now+750);
 await assert.rejects(consumeRegistrationChallenge(early.request,f.env,early.username,early.registration),e=>e.status===400);
 const timely=await mint(f,'timelyproof',ip,{age:false});
 t.mock.method(Date,'now',()=>now+1500);await consumeRegistrationChallenge(timely.request,f.env,timely.username,timely.registration);
 const expired=await mint(f,'expiredproof',ip,{age:false});
 t.mock.method(Date,'now',()=>expired.data.expiresAt);
 await assert.rejects(consumeRegistrationChallenge(expired.request,f.env,expired.username,expired.registration),e=>e.status===400);
});

test('honeypots and invalid usernames are rejected before challenge issuance',async()=>{
 const f=environment();
 for(const data of [{username:'abc'},{username:'validuser',website:'filled'},{username:'validuser',website:null}])await assert.rejects(createRegistrationChallenge(request(),f.env,data),e=>e.status===400);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM registration_challenges').get().n,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,0);
 const challenge=await mint(f,'honeypotuser');
 await assert.rejects(passwordAccount(challenge.request,f.env,{username:challenge.username,password,registration:challenge.registration,website:'filled'},true),e=>e.status===400);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
});

test('registration requires the security gate before duplicate lookup or password derivation',async()=>{
 const f=environment(),prepare=f.env.DB.prepare.bind(f.env.DB);let lookedUp=false;
 f.env.DB.prepare=query=>{if(query.includes('SELECT p.password_hash'))lookedUp=true;return prepare(query);};
 await assert.rejects(passwordAccount(request(),f.env,{username:'missingproof',password},true),e=>e.status===400);
 assert.equal(lookedUp,false);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
 const challenge=await mint(f,'successfuluser');
 const account=await passwordAccount(challenge.request,f.env,{username:challenge.username,password,registration:challenge.registration},true);
 assert.equal(account.user.label,'successfuluser');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM account_trials').get().n,1);
});

test('rolling signup windows do not reset at the clock boundary and enforce the separate daily ceiling',async t=>{
 const f=environment();let now=3600000-1;t.mock.method(Date,'now',()=>now);
 for(let i=0;i<3;i++)await authRate(request(),f.env,'register','boundary'+i);
 now=3600000+1;
 await assert.rejects(authRate(request(),f.env,'register','boundarythree'),e=>e.status===429);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM auth_attempts WHERE action='register'").get().n,3);
 const first=3600000-1;now=first+3600001;await authRate(request(),f.env,'register','laterboundary');
 for(const [offset,count] of [[3,3],[5,3]]){now=first+offset*3600000;for(let i=0;i<count;i++)await authRate(request(),f.env,'register','daily'+offset+'_'+i);}
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM auth_attempts WHERE action='register'").get().n,10);
 now=first+7*3600000;
 await assert.rejects(authRate(request(),f.env,'register','dailyoverlimit'),e=>e.status===429);
});

test('rejected local attempts do not spend global quota or another identity quota',async()=>{
 const f=environment();
 for(let i=0;i<10;i++)await authRate(request(),f.env,'login','lockedidentity');
 for(let i=0;i<220;i++)await assert.rejects(authRate(request(),f.env,'login','lockedidentity'),e=>e.status===429);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,10);
 await authRate(request('', '192.0.2.99'),f.env,'login','unrelatedidentity');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,11);
});

test('registration attempts and challenge issuance do not lock an existing account out of login',async()=>{
 const f=environment(),challenge=await mint(f,'existingvictim');
 await passwordAccount(challenge.request,f.env,{username:challenge.username,password,registration:challenge.registration},true);
 for(let i=0;i<3;i++)await authRate(request('', '192.0.2.20'),f.env,'register','existingvictim');
 for(let i=0;i<20;i++)await assert.rejects(authRate(request('', '192.0.2.20'),f.env,'register','existingvictim'),e=>e.status===429);
 for(let i=0;i<20;i++)await authRate(request('', '192.0.2.21'),f.env,'challenge','existingvictim');
 const signedIn=await passwordAccount(request('', '192.0.2.22'),f.env,{username:challenge.username,password},false);
 assert.equal(signedIn.user.label,'existingvictim');
});

test('network, identity and global rolling limits are independent and concurrent admission is atomic',async()=>{
 const f=environment();
 const admitted=await Promise.allSettled(Array.from({length:12},(_,i)=>authRate(request(),f.env,'register','concurrent'+i)));
 assert.equal(admitted.filter(r=>r.status==='fulfilled').length,3);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,3);
 for(let i=0;i<5;i++)await authRate(request('', '198.51.100.'+(i+1)),f.env,'register','sameidentity');
 await assert.rejects(authRate(request('', '198.51.100.99'),f.env,'register','sameidentity'),e=>e.status===429);
 const g=environment();
 for(let i=0;i<100;i++)await authRate(request('', '198.51.100.'+(i+1)),g.env,'register','global'+i);
 await assert.rejects(authRate(request('', '203.0.113.1'),g.env,'register','globaloverlimit'),e=>e.status===429);
 assert.equal(g.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,100);
});

test('login enforces twenty per network, fifty per identity and two hundred globally without counting denied requests',async()=>{
 const f=environment();for(let i=0;i<20;i++)await authRate(request(),f.env,'login','networkuser'+i);
 await assert.rejects(authRate(request(),f.env,'login','networkoverlimit'),e=>e.status===429);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,20);
 const g=environment();for(let i=0;i<50;i++)await authRate(request('', '198.51.100.'+(i+1)),g.env,'login','identitycap');
 await assert.rejects(authRate(request('', '198.51.100.99'),g.env,'login','identitycap'),e=>e.status===429);
 assert.equal(g.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,50);
 const h=environment();for(let i=0;i<200;i++)await authRate(request('', '198.51.100.'+(i+1)),h.env,'login','globalcap'+i);
 await assert.rejects(authRate(request('', '203.0.113.1'),h.env,'login','globaloverlimit'),e=>e.status===429);
 assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,200);
});

test('challenge limits are independent from registration and login and enforce twenty per network plus one thousand globally',async()=>{
 const f=environment();for(let i=0;i<3;i++)await authRate(request(),f.env,'register','independent'+i);
 for(let i=0;i<10;i++)await authRate(request(),f.env,'login','independentlogin');
 for(let i=0;i<20;i++)await authRate(request(),f.env,'challenge','independentchallenge');
 await assert.rejects(authRate(request(),f.env,'challenge','challengeoverlimit'),e=>e.status===429);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM auth_attempts WHERE action='challenge'").get().n,20);
 const g=environment();for(let i=0;i<1000;i++)await authRate(request('', '198.51.100.'+(Math.floor(i/20)+1)),g.env,'challenge','globalchallenge');
 await assert.rejects(authRate(request('', '203.0.113.1'),g.env,'challenge','challengeoverlimit'),e=>e.status===429);
 assert.equal(g.sql.prepare('SELECT COUNT(*) n FROM auth_attempts').get().n,1000);
});

test('bounded retention removes at most one hundred expired attempts and challenges per call while preserving live windows',async t=>{
 const f=environment(),now=30*86400000;t.mock.method(Date,'now',()=>now);
 const insertAttempt=f.sql.prepare('INSERT INTO auth_attempts(id,action,network_hash,identity_hash,created_at) VALUES(?,?,?,?,?)'),insertChallenge=f.sql.prepare('INSERT INTO registration_challenges(id,nonce,network_hash,username_hash,browser_hash,created_at,expires_at,claimed_at) VALUES(?,?,?,?,?,?,?,NULL)');
 for(let i=0;i<250;i++){
  insertAttempt.run('old-attempt-'+i,'login','old-network','old-identity',now-86400000);
  insertChallenge.run('old-challenge-'+i,'old-nonce','old-network','old-identity','old-browser',now-600000,now);
 }
 insertAttempt.run('recent-attempt','login','recent-network','recent-identity',now-86400000+1);
 insertChallenge.run('live-challenge','live-nonce','live-network','live-identity','live-browser',now,now+300000);
 await authRate(request(),f.env,'register','retentionuser');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts WHERE created_at<=?').get(now-86400000).n,150);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM registration_challenges WHERE expires_at<=?').get(now).n,150);
 await authRate(request(),f.env,'login','retentionuser');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts WHERE created_at<=?').get(now-86400000).n,50);
 await authRate(request(),f.env,'challenge','retentionuser');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM auth_attempts WHERE created_at<=?').get(now-86400000).n,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM registration_challenges').get().n,1);
 assert.ok(f.sql.prepare('SELECT id FROM auth_attempts WHERE id=?').get('recent-attempt'));
 assert.ok(f.sql.prepare('SELECT id FROM registration_challenges WHERE id=?').get('live-challenge'));
});

test('IPv6 addresses share a /64 bucket, mapped IPv4 shares IPv4, and missing IPs conservatively share unknown',async()=>{
 const f=environment();
 for(const [i,address] of ['2001:db8:abcd:1234::1','2001:0db8:abcd:1234:0:0:0:2','2001:db8:abcd:1234:ffff:ffff:ffff:ffff'].entries())await authRate(request('',address),f.env,'register','ipv6user'+i);
 await assert.rejects(authRate(request('','2001:db8:abcd:1234::4'),f.env,'register','ipv6blocked'),e=>e.status===429);
 await authRate(request('','2001:db8:abcd:1235::1'),f.env,'register','ipv6otherprefix');
 const g=environment();
 for(let i=0;i<3;i++)await authRate(request('','192.0.2.1'),g.env,'register','mappeduser'+i);
 await assert.rejects(authRate(request('','::ffff:192.0.2.1'),g.env,'register','mappedblocked'),e=>e.status===429);
 const h=environment();for(let i=0;i<3;i++)await authRate(request('',null),h.env,'register','unknownuser'+i);
 await assert.rejects(authRate(request('','not-an-ip'),h.env,'register','unknownblocked'),e=>e.status===429);
});

test('concurrent registration cannot replay a challenge or issue a second trial',async()=>{
 const f=environment(),batch=f.env.DB.batch.bind(f.env.DB);let pending=Promise.resolve();
 f.env.DB.batch=items=>{const result=pending.then(()=>batch(items));pending=result.catch(()=>{});return result;};
 const challenge=await mint(f,'concurrentregistration'),body={username:challenge.username,password,registration:challenge.registration};
 const results=await Promise.allSettled([passwordAccount(challenge.request,f.env,body,true),passwordAccount(challenge.request,f.env,body,true)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const table of ['accounts','account_passwords','account_trials','trial_claims'])assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,1);
});

test('failed registration batches roll back account, password and trial while the spent challenge remains consumed',async()=>{
 const f=environment(),challenge=await mint(f,'rollbackregistration');
 f.sql.exec("CREATE TRIGGER fail_trial BEFORE INSERT ON account_trials BEGIN SELECT RAISE(ABORT,'synthetic trial failure'); END");
 await assert.rejects(passwordAccount(challenge.request,f.env,{username:challenge.username,password,registration:challenge.registration},true),/synthetic trial failure/);
 for(const table of ['accounts','account_passwords','account_trials','trial_claims'])assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
 assert.ok(f.sql.prepare('SELECT claimed_at FROM registration_challenges WHERE id=?').get(challenge.data.challengeId).claimed_at);
 await assert.rejects(consumeRegistrationChallenge(challenge.request,f.env,challenge.username,challenge.registration),e=>e.status===400);
});

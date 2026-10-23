import test from 'node:test';
import assert from 'node:assert/strict';
import {environment} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {trialFor} from '../src/trial.js';
import {digest} from '../src/security-common.js';
function serialize(env){const original=env.DB.batch.bind(env.DB);let previous=Promise.resolve();env.DB.batch=items=>{const result=previous.then(()=>original(items));previous=result.catch(()=>{});return result;};}
function removeAccount(sql,id){for(const table of ['account_trials','account_sessions','account_memberships','account_security'])sql.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(id);sql.prepare('DELETE FROM accounts WHERE id=?').run(id);}
test('deleting and recreating an identity never grants the same one-hour trial again',async()=>{
 const {env,sql}=environment(),identity={provider:'email',subject:'claimed@example.test',label:'Trial user'};
 const first=await createVerifiedAccountSession(env,identity);assert.ok(await trialFor(env,first.user.id));
 const claim=sql.prepare('SELECT * FROM trial_claims').get();assert.equal(Object.keys(claim).sort().join(','),'claim_token,claimed_at,identity_hash');assert.match(claim.identity_hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(claim).includes(identity.subject));assert.notEqual(claim.claim_token,first.user.id);
 removeAccount(sql,first.user.id);
 const recreated=await createVerifiedAccountSession(env,identity);assert.notEqual(recreated.user.id,first.user.id);assert.equal(await trialFor(env,recreated.user.id),null);assert.equal(sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,1);
 const different=await createVerifiedAccountSession(env,{...identity,subject:'another@example.test'});assert.ok(await trialFor(env,different.user.id));
});
test('claim, account and trial roll back together; a fresh registration can retry safely',async()=>{
 const {env,sql}=environment(),identity={provider:'phone',subject:'+447700900001'};
 sql.exec("CREATE TRIGGER fail_trial BEFORE INSERT ON account_trials BEGIN SELECT RAISE(ABORT,'synthetic grant failure'); END");
 await assert.rejects(()=>createVerifiedAccountSession(env,identity),/synthetic grant failure/);
 for(const table of ['accounts','trial_claims','account_trials'])assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 sql.exec('DROP TRIGGER fail_trial');assert.ok(await trialFor(env,(await createVerifiedAccountSession(env,identity)).user.id));
});
test('concurrent registration and later logins keep exactly one claim and grant',async()=>{
 const {env,sql}=environment();serialize(env);const identity={provider:'email',subject:'parallel@example.test'};
 const accounts=await Promise.all(Array.from({length:6},()=>createVerifiedAccountSession(env,identity)));assert.equal(new Set(accounts.map(a=>a.user.id)).size,1);
 for(const table of ['accounts','trial_claims','account_trials'])assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1);
 const id=accounts[0].user.id;sql.prepare('DELETE FROM account_trials WHERE account_id=?').run(id);
 await createVerifiedAccountSession(env,identity);assert.equal(await trialFor(env,id),null);
});
test('signing into a legacy identity creates neither a retroactive trial nor a new claim',async()=>{
 const {env,sql}=environment(),identity={provider:'email',subject:'legacy-claim@example.test'};
 sql.prepare('INSERT INTO accounts (id,provider,subject_hash,label,created_at) VALUES (?,?,?,?,?)').run('legacy',identity.provider,await digest('email:'+identity.subject),'Legacy',1);
 const result=await createVerifiedAccountSession(env,identity);assert.equal(result.user.id,'legacy');assert.equal(await trialFor(env,'legacy'),null);assert.equal(sql.prepare('SELECT COUNT(*) n FROM trial_claims').get().n,0);
});

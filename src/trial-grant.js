import {MemberError} from './errors.js';
const encoder=new TextEncoder();
export async function trialClaimIdentity(env,provider,subjectHash){
 const secret=env.TRIAL_CLAIM_SECRET||env.MEMBER_SESSION_SECRET||env.OPENAI_API_KEY;
 if(typeof secret!=='string'||!secret)throw new MemberError('账户安全服务暂不可用，请稍后重试。',503);
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('HMAC',key,encoder.encode('trial-claim:v1:'+provider+':'+subjectHash));
 return Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');
}
// Include these statements in the SAME transaction that inserts the account.
// The random claim token links only this registration transaction. It is not an
// account id and the deduplication row contains neither username nor raw IP.
export async function trialGrantStatements(env,{accountId,provider,subjectHash,createdAt}){
 const identity=await trialClaimIdentity(env,provider,subjectHash),claim=crypto.randomUUID();
 return [
  env.DB.prepare(`INSERT INTO trial_claims (identity_hash,claim_token,claimed_at)
   SELECT ?,?,? FROM accounts WHERE id=? AND provider=? AND subject_hash=?
   ON CONFLICT(identity_hash) DO NOTHING`).bind(identity,claim,createdAt,accountId,provider,subjectHash),
  env.DB.prepare(`INSERT INTO account_trials (account_id,granted_at)
   SELECT id,? FROM accounts WHERE id=? AND EXISTS(SELECT 1 FROM trial_claims WHERE identity_hash=? AND claim_token=?)
   ON CONFLICT(account_id) DO NOTHING`).bind(createdAt,accountId,identity,claim)
 ];
}

// Accounts that received a trial before this ledger was introduced must also
// retain their claim when their personal account records are removed.
export async function preserveGrantedTrialClaim(env,accountId){
 const row=await env.DB.prepare('SELECT a.provider,a.subject_hash FROM accounts a JOIN account_trials t ON t.account_id=a.id WHERE a.id=?').bind(accountId).first();
 if(!row)return null;
 const identity=await trialClaimIdentity(env,row.provider,row.subject_hash);
 return env.DB.prepare(`INSERT INTO trial_claims (identity_hash,claim_token,claimed_at)
  SELECT ?,?,t.granted_at FROM account_trials t WHERE t.account_id=?
  ON CONFLICT(identity_hash) DO NOTHING`).bind(identity,crypto.randomUUID(),accountId);
}

import {MemberError} from './errors.js';
// A trial is granted only inside the registration transaction. Reading or
// signing in to a pre-existing account must never create another grant.
export async function trialFor(env,accountId){
 if(!env.DB)throw new MemberError('账户服务暂不可用，请稍后重试。');
 const trial=await env.DB.prepare('SELECT granted_at FROM account_trials WHERE account_id = ?').bind(accountId).first();
 return trial?{tier:'trial',active:true,accountId,expiresAt:null,trial:true,periodAnchor:trial.granted_at}:null;
}

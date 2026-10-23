import {MemberError} from './errors.js';
import {requireAccount} from './account-server.js';
import {hashPassword,verifyPassword} from './password-server.js';
import {securityState,securityRate,auditStatement,validPassword,digest,randomToken} from './security-common.js';
export const recoveryReady=env=>!!(env.DB&&env.RECOVERY_EMAIL_PROVIDER==='resend'&&env.RESEND_API_KEY&&env.RECOVERY_EMAIL_FROM);
export async function reauthenticate(request,env,password,action='reauth'){
 const user=await requireAccount(request,env);await securityRate(request,env,action,user.id,6);
 const state=await securityState(env,user.id);
 const row=await env.DB.prepare('SELECT password_hash FROM account_passwords WHERE account_id=?').bind(user.id).first();
 if(typeof password!=='string'||password.length>128||!await verifyPassword(password,row?.password_hash))throw new MemberError('当前密码不正确',401);
 if(state.status!=='active')throw new MemberError('账户不可操作',403);
 return {user,version:state.version,passwordHash:row.password_hash};
}
export async function accountSecurityInfo(env,user){
 const email=await env.DB.prepare('SELECT email FROM recovery_emails WHERE account_id=?').bind(user.id).first();
 return {emailReady:recoveryReady(env),verifiedEmail:email?email.email[0]+'***@'+email.email.split('@')[1]:null};
}
async function replacePassword(env,id,version,newPassword,action){
 const username=await env.DB.prepare('SELECT username FROM account_passwords WHERE account_id=?').bind(id).first();
 const next=await hashPassword(validPassword(newPassword,username?.username)),auditId=crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'account',?,'{}',? FROM account_security WHERE account_id=? AND version=? AND status='active'").bind(auditId,await digest('audit:'+id),action,Date.now(),id,version),
  env.DB.prepare("UPDATE account_passwords SET password_hash=? WHERE account_id=? AND EXISTS (SELECT 1 FROM account_security WHERE account_id=? AND version=? AND status='active')").bind(next,id,id,version),
  env.DB.prepare("UPDATE account_security SET version=version+1,updated_at=? WHERE account_id=? AND version=? AND status='active'").bind(Date.now(),id,version),
  env.DB.prepare('DELETE FROM account_sessions WHERE account_id=? AND EXISTS (SELECT 1 FROM security_audit WHERE id=?)').bind(id,auditId),
  env.DB.prepare('DELETE FROM recovery_challenges WHERE account_id=? AND EXISTS (SELECT 1 FROM security_audit WHERE id=?)').bind(id,auditId)
 ]);
 if(!await env.DB.prepare('SELECT id FROM security_audit WHERE id=?').bind(auditId).first())throw new MemberError('账号状态已变化，请重试',409);
 return {ok:true,signInAgain:true};
}
export async function changePassword(request,env,data){const {user,version}=await reauthenticate(request,env,data.currentPassword,'change-password');return replacePassword(env,user.id,version,data.newPassword,'password_changed');}
function emailAddress(value){const email=typeof value==='string'?value.trim().toLowerCase():'';if(email.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email))throw new MemberError('请输入有效邮箱',400);return email;}
async function sendEmail(env,email,code,upstream){
 let response;try{response=await upstream('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.RECOVERY_EMAIL_FROM,to:[email],subject:'满绩速翻 · 账户验证码',text:'你的账户验证码是 '+code+'，10 分钟内有效。如非本人操作，请忽略。请勿向他人提供验证码。'}),signal:AbortSignal.timeout(15000)});}catch{throw new MemberError('邮件发送暂不可用，请稍后重试',503);}
 if(!response.ok)throw new MemberError('邮件发送暂不可用，请稍后重试',503);
}
export async function sendRecovery(request,env,data,purpose,upstream){
 if(!recoveryReady(env))throw new MemberError('邮箱恢复尚未启用',503);
 const email=emailAddress(data.email);
 // Authenticate a bind request before it can consume another person's mail quota.
 const auth=purpose==='bind'?await reauthenticate(request,env,data.currentPassword,'bind-email'):null;
 await securityRate(request,env,'email-send',email,5);
 // Per-recipient cooldown and total spend protection also cover nonexistent identities.
 const {consume}=await import('./member.js');await consume(env,'email-minute:'+await digest(email),1,60);await consume(env,'email-global',100,86400);
 let id=null,version=-1;
 if(purpose==='bind'){
  id=auth.user.id;version=auth.version;
  const other=await env.DB.prepare('SELECT account_id FROM recovery_emails WHERE email=?').bind(email).first();if(other&&other.account_id!==id)throw new MemberError('无法绑定此邮箱',409);
 }else{
  const username=typeof data.username==='string'?data.username.trim().toLowerCase():'';
  const row=await env.DB.prepare('SELECT p.account_id FROM account_passwords p JOIN recovery_emails r ON r.account_id=p.account_id WHERE p.username=? AND r.email=?').bind(username,email).first();
  if(row){const state=await securityState(env,row.account_id);if(state.status==='active'){id=row.account_id;version=state.version;}}
 }
 const challengeId=crypto.randomUUID(),code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
 await env.DB.batch([env.DB.prepare('DELETE FROM recovery_challenges WHERE expires_at<=?').bind(Date.now()),env.DB.prepare('DELETE FROM recovery_challenges WHERE email=? AND purpose=?').bind(email,purpose)]);
 if(id){
  await env.DB.prepare('INSERT INTO recovery_challenges (id,account_id,purpose,email,code_hash,version,attempts,expires_at) VALUES (?,?,?,?,?,?,0,?)').bind(challengeId,id,purpose,email,await digest(challengeId+':'+code),version,Date.now()+600000).run();
  try{await sendEmail(env,email,code,upstream);}catch(e){await env.DB.prepare('DELETE FROM recovery_challenges WHERE id=?').bind(challengeId).run();throw e;}
 }
 return {challengeId,retryAfter:60,message:purpose==='bind'?'验证码已发送':'若账号与已验证邮箱匹配，验证码将发送至该邮箱。'};
}
export async function finishRecovery(request,env,data,purpose){
 if(!recoveryReady(env))throw new MemberError('邮箱恢复尚未启用',503);
 await securityRate(request,env,'email-check',data.challengeId||'',20);
 if(typeof data.challengeId!=='string'||typeof data.code!=='string'||!/^\d{6}$/.test(data.code))throw new MemberError('验证码无效或已过期',400);
 const row=await env.DB.prepare('UPDATE recovery_challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND expires_at>? AND attempts<5 RETURNING *').bind(data.challengeId,purpose,Date.now()).first();
 if(!row||row.code_hash!==await digest(data.challengeId+':'+data.code))throw new MemberError('验证码无效或已过期',400);
 if(purpose==='bind'){const user=await requireAccount(request,env);if(user.id!==row.account_id)throw new MemberError('验证码无效或已过期',400);}
 const state=await securityState(env,row.account_id);if(state.status!=='active'||state.version!==row.version)throw new MemberError('验证码无效或已过期',400);
 if(purpose==='reset'){const username=await env.DB.prepare('SELECT username FROM account_passwords WHERE account_id=?').bind(row.account_id).first();validPassword(data.newPassword,username?.username);}
 // Claim once before doing any mutation. A database failure requires a fresh challenge.
 const claimed=await env.DB.prepare('DELETE FROM recovery_challenges WHERE id=? AND expires_at>? RETURNING id').bind(row.id,Date.now()).first();if(!claimed)throw new MemberError('验证码已使用',400);
 if(purpose==='reset')return replacePassword(env,row.account_id,row.version,data.newPassword,'password_reset');
 const auditId=crypto.randomUUID();
 try{await env.DB.batch([
  env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'account','recovery_email_verified','{}',? FROM account_security WHERE account_id=? AND version=? AND status='active'").bind(auditId,await digest('audit:'+row.account_id),Date.now(),row.account_id,row.version),
  env.DB.prepare("INSERT INTO recovery_emails (account_id,email,verified_at) SELECT account_id,?,? FROM account_security WHERE account_id=? AND version=? AND status='active' ON CONFLICT(account_id) DO UPDATE SET email=excluded.email,verified_at=excluded.verified_at").bind(row.email,Date.now(),row.account_id,row.version),
  env.DB.prepare("UPDATE account_security SET version=version+1 WHERE account_id=? AND version=? AND status='active'").bind(row.account_id,row.version),
  env.DB.prepare('DELETE FROM recovery_challenges WHERE account_id=?').bind(row.account_id)
 ]);}catch{throw new MemberError('无法绑定此邮箱，请重新验证',409);}
 if(!await env.DB.prepare('SELECT id FROM security_audit WHERE id=?').bind(auditId).first())throw new MemberError('账号状态已变化',409);
 return {ok:true};
}

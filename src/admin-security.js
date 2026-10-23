import {MemberError} from './errors.js';
import {securityState,digest} from './security-common.js';
import {adminMembership} from './admin-membership.js';
export async function adminSecurity(env,username){
 const user=await adminMembership(env,username),state=await securityState(env,user.accountId);
 const audit=await env.DB.prepare('SELECT id,actor,action,details,created_at FROM security_audit WHERE subject=? ORDER BY created_at DESC LIMIT 100').bind(await digest('audit:'+user.accountId)).all();
 const membershipChanges=await env.DB.prepare('SELECT id,previous_tier,previous_expires_at,tier,expires_at,reason,created_at FROM membership_admin_audit WHERE account_id=? ORDER BY created_at DESC LIMIT 100').bind(user.accountId).all();
 return {...user,...state,audit:audit.results,membershipChanges:membershipChanges.results};
}
export async function adminSecurityAction(env,data){
 const {username,accountId,action,expectedVersion,reason}=data;
 if(!['block','unblock','refund_note'].includes(action)||typeof reason!=='string'||!reason.trim()||reason.length>300||!Number.isSafeInteger(expectedVersion))throw new MemberError('管理参数不正确',400);
 const user=await adminMembership(env,username),state=await securityState(env,user.accountId);
 if(user.accountId!==accountId||state.version!==expectedVersion||state.status==='deleting')throw new MemberError('账号状态已变化',409);
 if(action==='refund_note'){
  if(typeof data.reference!=='string'||!data.reference.trim()||data.reference.length>100||!['requested','externally_processed','rejected'].includes(data.outcome))throw new MemberError('请提供退款事项编号和处理情况',400);
  const auditId=crypto.randomUUID();
  // Keep the checked account version and audit insertion in one database statement.
  await env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'admin','refund_note',?,? FROM account_security WHERE account_id=? AND version=? AND status!='deleting'").bind(auditId,await digest('audit:'+accountId),JSON.stringify({reason:reason.trim(),reference:data.reference.trim(),outcome:data.outcome,recordOnly:true}),Date.now(),accountId,expectedVersion).run();
  if(!await env.DB.prepare('SELECT id FROM security_audit WHERE id=?').bind(auditId).first())throw new MemberError('账号状态已变化',409);
  return {ok:true,auditId,recordOnly:true,message:'仅记录人工退款事项，不发起付款，不验证资金到账，也不改变会员权益'};
 }
 const auditId=crypto.randomUUID(),status=action==='block'?'blocked':'active';
 await env.DB.batch([
  env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'admin',?,?,? FROM account_security WHERE account_id=? AND version=? AND status!='deleting'").bind(auditId,await digest('audit:'+accountId),action,JSON.stringify({reason:reason.trim(),previousStatus:state.status,status}),Date.now(),accountId,expectedVersion),
  env.DB.prepare("UPDATE account_security SET status=?,version=version+1,updated_at=? WHERE account_id=? AND version=? AND status!='deleting'").bind(status,Date.now(),accountId,expectedVersion),
  env.DB.prepare('DELETE FROM account_sessions WHERE account_id=? AND EXISTS(SELECT 1 FROM security_audit WHERE id=?)').bind(accountId,auditId),
  env.DB.prepare('DELETE FROM recovery_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM security_audit WHERE id=?)').bind(accountId,auditId)
 ]);
 if(!await env.DB.prepare('SELECT id FROM security_audit WHERE id=?').bind(auditId).first())throw new MemberError('账号状态已变化',409);
 return {ok:true,auditId,status};
}

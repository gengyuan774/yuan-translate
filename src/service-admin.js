import {MemberError} from './errors.js';
import {requireMemberAdmin} from './admin-membership.js';
import {digest,randomToken,auditStatement,securityRate} from './security-common.js';
import {serviceBudgetState,settings,emitAlerts,serviceState,myUsage} from './service-ledger.js';
import {membershipFor} from './member.js';
import {trialFor} from './trial.js';
import {moneyCny} from './service-plans.js';
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const cookieName='__Host-classroom_cost_admin';
const cookie=(value,age=1800)=>`${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
const reply=(data,headers={})=>Response.json(data,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function authorize(request,env){
 const value=request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(/^[a-f0-9]{64}$/.test(value||'')){
  const row=await stmt(env,"SELECT hash FROM service_admin_sessions WHERE hash=? AND kind='session' AND expires_at>?",await digest(value),Date.now()).first();
  if(row){await securityRate(request,env,'cost-admin','',120);return;}
 }
 await requireMemberAdmin(request,env);
}
export async function redeemAdminTicket(request,env,data){
 await securityRate(request,env,'cost-ticket','',20);
 if(typeof data.ticket!=='string'||!/^[a-f0-9]{64}$/.test(data.ticket))throw new MemberError('管理入口已失效，请从本机重新打开。',401);
 const hash=await digest(data.ticket),value=randomToken(),sessionHash=await digest(value);
 await env.DB.batch([
  stmt(env,"INSERT INTO service_admin_sessions (hash,kind,expires_at) SELECT ?,'session',? FROM service_admin_sessions WHERE hash=? AND kind='ticket' AND expires_at>?",sessionHash,Date.now()+1800000,hash,Date.now()),
  stmt(env,"DELETE FROM service_admin_sessions WHERE hash=? AND kind='ticket'",hash)
 ]);
 if(!await stmt(env,'SELECT hash FROM service_admin_sessions WHERE hash=?',sessionHash).first())throw new MemberError('管理入口已使用或过期，请从本机重新打开。',401);
 return reply({ok:true},{'Set-Cookie':cookie(value)});
}
export async function restrictAbuse(env,accountId,reason){
 await env.DB.batch([
  stmt(env,'UPDATE service_accounts SET restricted_until=MAX(restricted_until,?),reason=? WHERE account_id=?',Date.now()+15*60000,reason,accountId),
  await auditStatement(env,accountId,'system','service_abuse_restriction',{reason,durationMinutes:15})
 ]);
}
async function summary(env,username,cursor=''){
 const budget=await serviceBudgetState(env);
 const alerts=(await stmt(env,'SELECT id,kind,created_at,details FROM service_alerts WHERE month=? ORDER BY created_at DESC LIMIT 30',budget.month).all()).results;
 const rows=(await stmt(env,`SELECT a.id,a.label,p.username,s.anchor,s.restricted_until,s.reason,s.lease_expires FROM accounts a LEFT JOIN account_passwords p ON p.account_id=a.id LEFT JOIN service_accounts s ON s.account_id=a.id WHERE (?='' OR p.username=?) AND a.id>? ORDER BY a.id LIMIT 51`,username||'',username||'',cursor).all()).results;
 const accounts=[];
 for(const row of rows.slice(0,50)){
  const m=await membershipFor(env,row.id);
  const serviceMember=m.active?{...m,accountId:row.id}:await trialFor(env,row.id);
  const usage=serviceMember?await myUsage(null,env,serviceMember):{active:false};
  const monthly=await stmt(env,'SELECT COALESCE(SUM(cost),0) AS cost FROM service_requests WHERE account_id=? AND month=?',row.id,budget.month).first();
  accounts.push({monthlyCostCny:moneyCny(monthly.cost),id:row.id,username:row.username||row.label,membership:m,usage,restrictedUntil:row.restricted_until||0,reason:row.reason||'',recording:row.lease_expires>Date.now()});
 }
 const totals=(await stmt(env,'SELECT kind,state,COUNT(*) AS requests,SUM(audio_ms) AS audioMs,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,SUM(cost) AS costMicros FROM service_requests WHERE month=? GROUP BY kind,state',budget.month).all()).results;
 return {budget,alerts,accounts,totals,next:rows.length>50?rows[49].id:null};
}
export async function adminCostRoutes(request,env,url,data){
 await authorize(request,env);
 const path=url.pathname;
 if(path==='/api/admin/cost-session'&&request.method==='POST'){
  // Long-lived administrator credentials remain in the CLI. Only a one-use,
  // 60-second ticket crosses into the browser, then becomes an HttpOnly cookie.
  await requireMemberAdmin(request,env);
  const ticket=randomToken();await stmt(env,'DELETE FROM service_admin_sessions WHERE expires_at<=?',Date.now()).run();
  await stmt(env,"INSERT INTO service_admin_sessions (hash,kind,expires_at) VALUES (?,'ticket',?)",await digest(ticket),Date.now()+60000).run();
  return reply({ticket});
 }
 if(path==='/api/admin/cost-session/logout'&&request.method==='POST'){
  const value=request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
  await stmt(env,'DELETE FROM service_admin_sessions WHERE hash=?',await digest(value)).run();return reply({ok:true},{'Set-Cookie':cookie('',0)});
 }
 if(path==='/api/admin/costs'&&request.method==='GET')return reply(await summary(env,url.searchParams.get('username'),url.searchParams.get('after')||''));
 if(request.method!=='POST')throw new MemberError('不支持此操作',405);
 if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>300)throw new MemberError('请填写操作原因（最多 300 字）',400);
 if(path==='/api/admin/costs/settings'){
  const {warningCents,hardCents,paused,expectedRevision}=data;
  if(!Number.isSafeInteger(expectedRevision)||typeof paused!=='boolean'||[warningCents,hardCents].some(v=>v!==null&&(!Number.isSafeInteger(v)||v<1||v>100000000))||(hardCents!==null&&warningCents!==null&&warningCents>hardCents))throw new MemberError('预算参数不正确，金额单位为人民币分。',400);
  await settings(env);
  const id=crypto.randomUUID();
  await env.DB.batch([
   stmt(env,"INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,'service-global','admin','service_budget_changed',json_object('reason',?,'previousWarningCents',warning_cents,'previousHardCents',hard_cents,'previousPaused',paused,'warningCents',?,'hardCents',?,'paused',?),? FROM service_settings WHERE id='global' AND revision=?",id,data.reason.trim(),warningCents,hardCents,paused?1:0,Date.now(),expectedRevision),
   stmt(env,"UPDATE service_settings SET warning_cents=?,hard_cents=?,paused=?,revision=revision+1,updated_at=? WHERE id='global' AND revision=? AND EXISTS(SELECT 1 FROM security_audit WHERE id=?)",warningCents,hardCents,paused?1:0,Date.now(),expectedRevision,id)
  ]);
  if(!await stmt(env,'SELECT id FROM security_audit WHERE id=?',id).first())throw new MemberError('配置已变化，请刷新后重试。',409);
  await emitAlerts(env);return reply(await serviceBudgetState(env));
 }
 if(path==='/api/admin/costs/restrict'){
  if(typeof data.accountId!=='string'||!Number.isSafeInteger(data.until)||data.until<0||data.until>Date.now()+30*86400000||!Number.isSafeInteger(data.expectedUntil))throw new MemberError('限制时间参数不正确（最长 30 天）',400);
  const m=await membershipFor(env,data.accountId),serviceMember=m.active?{...m,accountId:data.accountId}:await trialFor(env,data.accountId);
  if(!await stmt(env,'SELECT id FROM accounts WHERE id=?',data.accountId).first())throw new MemberError('账号不存在',404);
  await serviceState(env,serviceMember||{accountId:data.accountId,tier:'none'});
  const id=crypto.randomUUID();
  await env.DB.batch([
   stmt(env,"INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'admin','service_restriction_changed',?,? FROM service_accounts WHERE account_id=? AND restricted_until=?",id,await digest('audit:'+data.accountId),JSON.stringify({reason:data.reason.trim(),until:data.until}),Date.now(),data.accountId,data.expectedUntil),
   stmt(env,'UPDATE service_accounts SET restricted_until=?,reason=? WHERE account_id=? AND EXISTS(SELECT 1 FROM security_audit WHERE id=?)',data.until,data.reason.trim(),data.accountId,id)
  ]);
  if(!await stmt(env,'SELECT id FROM security_audit WHERE id=?',id).first())throw new MemberError('账号状态已变化，请刷新。',409);
  return reply({ok:true});
 }
 if(path==='/api/admin/costs/compensate'){
  const row=await stmt(env,'SELECT * FROM service_requests WHERE id=?',String(data.requestId||'')).first();
  if(!row||!row.account_id)throw new MemberError('请求记录不存在或账号已注销。',404);
  if(row.state==='compensated')return reply({ok:true,alreadyCompensated:true});
  if(row.state!=='completed')throw new MemberError('失败请求已自动返还，无需再次补偿。',409);
  await env.DB.batch([
   stmt(env,"INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'admin','service_quota_compensated',?,? FROM service_requests WHERE id=? AND state='completed'",crypto.randomUUID(),await digest('audit:'+row.account_id),JSON.stringify({reason:data.reason.trim(),requestId:row.id}),Date.now(),row.id),
   stmt(env,"UPDATE service_periods SET audio_used=MAX(0,audio_used-?),input_used=MAX(0,input_used-?),output_used=MAX(0,output_used-?) WHERE account_id=? AND start=? AND EXISTS(SELECT 1 FROM service_requests WHERE id=? AND state='completed')",row.audio_ms,row.input_tokens,row.output_tokens,row.account_id,row.period,row.id),
   stmt(env,"UPDATE plan_balances SET audio_used=MAX(0,audio_used-?) WHERE account_id=? AND scope=? AND start=? AND EXISTS(SELECT 1 FROM service_requests WHERE id=? AND state='completed')",row.audio_ms,row.account_id,row.balance_scope,row.balance_start,row.id),
   stmt(env,"UPDATE service_requests SET state='compensated' WHERE id=? AND state='completed'",row.id)
  ]);return reply({ok:true,providerCostUnchanged:true});
 }
 if(path==='/api/admin/costs/requests'){
  const rows=(await stmt(env,'SELECT id,kind,state,audio_ms,input_tokens,output_tokens,cost,measurement,created_at FROM service_requests WHERE account_id=? ORDER BY created_at DESC LIMIT 100',String(data.accountId||'')).all()).results;
  return reply({requests:rows});
 }
 throw new MemberError('未找到管理操作',404);
}

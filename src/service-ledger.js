import {MemberError} from './errors.js';
import {memberSession} from './member.js';
import {PERIOD_MS,planFor,audioCost,textCost,USD_CNY,PRICING_VERSION,moneyCny} from './service-plans.js';
import {TEXT_MODEL,TRANSCRIPTION_MODEL} from './models.js';
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
export const monthAt=(now=Date.now())=>new Date(now).toISOString().slice(0,7);
export async function settings(env){
 await stmt(env,"INSERT INTO service_settings (id,updated_at) VALUES ('global',?) ON CONFLICT(id) DO NOTHING",Date.now()).run();
 return stmt(env,"SELECT * FROM service_settings WHERE id='global'").first();
}
// Published commercial allowances cannot be disabled by the legacy cost switch.
export const configuredPlan=(_config,tier)=>planFor(tier);
export async function publicPlans(env){await settings(env);return {quotaEnforced:true,periodDays:30,trialOnce:true,limits:{trial:planFor('trial'),regular:planFor('regular'),premium:planFor('premium')}};}
export async function emitAlerts(env){
 const month=monthAt(),s=await settings(env),b=await stmt(env,'SELECT * FROM service_budgets WHERE month=?',month).first();
 const cents=Math.ceil(((b?.spent||0)+(b?.reserved||0))*USD_CNY/10000);
 for(const [kind,threshold] of [['warning',s.warning_cents],['emergency',s.hard_cents]]){
  if(threshold!==null&&cents>=threshold)await stmt(env,'INSERT INTO service_alerts (id,month,kind,created_at,details) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',month+':'+kind+':'+s.revision,month,kind,Date.now(),JSON.stringify({cents,threshold,includesReservations:true})).run();
 }
}
export async function serviceState(env,member,now=Date.now()){
 await settings(env);
 await stmt(env,'INSERT INTO service_accounts (account_id,anchor) VALUES (?,?) ON CONFLICT(account_id) DO NOTHING',member.accountId,now).run();
 const account=await stmt(env,'SELECT * FROM service_accounts WHERE account_id=?',member.accountId).first();
 const anchor=Number.isSafeInteger(member.periodAnchor)?member.periodAnchor:account.anchor;
 const scope=member.tier,start=scope==='trial'?anchor:anchor+Math.max(0,Math.floor((now-anchor)/PERIOD_MS))*PERIOD_MS;
 await env.DB.batch([
  stmt(env,'INSERT INTO service_periods (account_id,start) VALUES (?,?) ON CONFLICT(account_id,start) DO NOTHING',member.accountId,start),
  stmt(env,'INSERT INTO plan_balances (account_id,scope,start) VALUES (?,?,?) ON CONFLICT(account_id,scope,start) DO NOTHING',member.accountId,scope,start)
 ]);
 const period=await stmt(env,'SELECT * FROM service_periods WHERE account_id=? AND start=?',member.accountId,start).first();
 const balance=await stmt(env,'SELECT * FROM plan_balances WHERE account_id=? AND scope=? AND start=?',member.accountId,scope,start).first();
 return {account,period,balance,plan:planFor(member.tier),member};
}
export async function requireService(request,env){
 const member=await memberSession(request,env);
 if(!member)throw new MemberError('请先登录，新账号赠送 1 小时免费翻译；也可开通会员。',401);
 const state=await serviceState(env,member);
 if(state.account.restricted_until>Date.now())throw new MemberError('此账号的 AI 服务暂时受限，请在个人中心查看恢复时间或联系客服。',403);
 if((await settings(env)).paused)throw new MemberError('本站已暂停新增 AI 消耗，请稍后再试。',503);
 return state;
}
export async function myUsage(request,env,member){
 if(!member)member=await memberSession(request,env);
 if(!member)return {active:false};
 await recoverExpired(env);
 const s=await serviceState(env,member),p=s.period,b=s.balance,config=await settings(env);
 return {quotaEnforced:true,active:true,tier:member.tier,periodStart:member.tier==='trial'?null:b.start,periodEnd:member.tier==='trial'?null:b.start+PERIOD_MS,minutes:s.plan.minutes,usedMinutes:b.audio_used/60000,reservedMinutes:b.audio_reserved/60000,remainingMinutes:s.plan.minutes===null?null:Math.max(0,s.plan.minutes-(b.audio_used+b.audio_reserved)/60000),summaries:s.plan.summaries,summariesUsed:b.summaries_used,summariesReserved:b.summaries_reserved,summariesRemaining:s.plan.summaries===null?null:Math.max(0,s.plan.summaries-b.summaries_used-b.summaries_reserved),inputLimit:null,inputUsed:p.input_used,inputReserved:p.input_reserved,outputLimit:null,outputUsed:p.output_used,outputReserved:p.output_reserved,concurrentRecordings:1,concurrentTextRequests:2,restrictedUntil:s.account.restricted_until,restrictionReason:s.account.restricted_until>Date.now()?s.account.reason:'',paused:!!config.paused};
}
export async function acquireLease(request,env){
 await recoverExpired(env);const s=await requireService(request,env),id=crypto.randomUUID(),now=Date.now();
 const owner=new URL(request.url).searchParams.get('owner')||'';if(owner&&!/^[a-f0-9-]{36}$/.test(owner))throw new MemberError('录音标识无效',400);
 if(s.plan.minutes!==null&&s.balance.audio_used+s.balance.audio_reserved>=s.plan.minutes*60000)throw new MemberError(s.member.tier==='trial'?'1 小时免费翻译已用完，请开通会员继续。':'本期 30 小时翻译额度已用完，请等待下期重置或联系客服。',402);
 const row=await stmt(env,`UPDATE service_accounts SET lease_id=?,lease_owner=?,lease_expires=? WHERE account_id=? AND (lease_expires<=? OR (?!='' AND lease_owner=?)) RETURNING account_id`,id,owner,now+90000,s.member.accountId,now,owner,owner).first();
 if(!row)throw new MemberError('此账号已有一节课堂正在录音，请先暂停或结束另一台设备上的录音。',409);
 return {id,accountId:s.member.accountId,tier:s.member.tier};
}
export async function releaseLease(env,lease){await stmt(env,'UPDATE service_accounts SET lease_id=NULL,lease_expires=0 WHERE account_id=? AND lease_id=?',lease.accountId,lease.id).run();}
export async function renewLease(request,env,lease){
 await requireService(request,env);
 const row=await stmt(env,'UPDATE service_accounts SET lease_expires=? WHERE account_id=? AND lease_id=? AND lease_expires>? RETURNING account_id',Date.now()+90000,lease.accountId,lease.id,Date.now()).first();
 if(!row)throw new MemberError('录音连接已失效，请重新连接。',409);
}
export async function reserve(request,env,{kind,audioMs=0,inputTokens=0,outputTokens=0,lease=null}){
 await recoverExpired(env);const s=await requireService(request,env),now=Date.now(),id=crypto.randomUUID(),month=monthAt(now);
 const cost=kind==='audio'?audioCost(audioMs):textCost(inputTokens,outputTokens);
 if(![audioMs,inputTokens,outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||!Number.isSafeInteger(cost)||cost<1||!['audio','text'].includes(kind))throw new MemberError('用量参数错误',400);
 await stmt(env,'INSERT INTO service_budgets (month) VALUES (?) ON CONFLICT(month) DO NOTHING',month).run();
 // Admission and all reservations are one D1 transaction, across isolates.
 await env.DB.batch([
  stmt(env,`INSERT INTO service_requests (id,account_id,period,month,kind,state,audio_ms,input_tokens,output_tokens,reserved_cost,expires_at,created_at,model,pricing_version,balance_scope,balance_start)
   SELECT ?,p.account_id,p.start,?,?,'reserved',?,?,?,?,?,?,?,?,?,? FROM service_periods p JOIN service_accounts a ON a.account_id=p.account_id JOIN service_settings s ON s.id='global' JOIN service_budgets b ON b.month=? JOIN plan_balances q ON q.account_id=p.account_id AND q.scope=? AND q.start=?
   WHERE p.account_id=? AND p.start=? AND s.paused=0 AND a.restricted_until<=?
   AND (? IS NULL OR q.audio_used+q.audio_reserved+?<=?)
   AND (s.hard_cents IS NULL OR (b.spent+b.reserved+?)*?<=s.hard_cents*10000)
   AND (?!='audio' OR (a.lease_id=? AND a.lease_expires>?))
   AND (?!='text' OR (SELECT COUNT(*) FROM service_requests r WHERE r.account_id=p.account_id AND r.kind='text' AND r.state='reserved' AND r.expires_at>?)<2)`,
   id,month,kind,audioMs,inputTokens,outputTokens,cost,now+120000,now,kind==='audio'?TRANSCRIPTION_MODEL:TEXT_MODEL,PRICING_VERSION,s.balance.scope,s.balance.start,month,s.balance.scope,s.balance.start,s.member.accountId,s.period.start,now,s.plan.minutes,audioMs,s.plan.minutes===null?null:s.plan.minutes*60000,cost,USD_CNY,kind,lease?.id||'',now,kind,now),
  stmt(env,`UPDATE service_periods SET audio_reserved=audio_reserved+?,input_reserved=input_reserved+?,output_reserved=output_reserved+? WHERE account_id=? AND start=? AND EXISTS(SELECT 1 FROM service_requests WHERE id=?)`,audioMs,inputTokens,outputTokens,s.member.accountId,s.period.start,id),
  stmt(env,`UPDATE plan_balances SET audio_reserved=audio_reserved+? WHERE account_id=? AND scope=? AND start=? AND EXISTS(SELECT 1 FROM service_requests WHERE id=?)`,audioMs,s.member.accountId,s.balance.scope,s.balance.start,id),
  stmt(env,'UPDATE service_budgets SET reserved=reserved+? WHERE month=? AND EXISTS(SELECT 1 FROM service_requests WHERE id=?)',cost,month,id)
 ]);
 const row=await stmt(env,'SELECT * FROM service_requests WHERE id=?',id).first();
 if(!row){
  await emitAlerts(env);const config=await settings(env),budget=await stmt(env,'SELECT spent,reserved FROM service_budgets WHERE month=?',month).first();
  if(config.hard_cents!==null&&(budget.spent+budget.reserved+cost)*USD_CNY>config.hard_cents*10000)await stmt(env,'INSERT INTO service_alerts (id,month,kind,created_at,details) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',month+':emergency:'+config.revision,month,'emergency',now,JSON.stringify({blockedReservation:true,threshold:config.hard_cents})).run();
  throw new MemberError('未发起请求：翻译时长、并发数或全站预算已达上限，请查看个人中心或联系客服。',402);}
 await emitAlerts(env);return row;
}
export async function settle(env,row,{success=false,usage=null,providerAccepted=false,requestId=null}={}){
 const input=Number.isSafeInteger(usage?.input_tokens)&&usage.input_tokens>=0?usage.input_tokens:null;
 const output=Number.isSafeInteger(usage?.output_tokens)&&usage.output_tokens>=0?usage.output_tokens:null;
 const known=input!==null&&output!==null;
 const cached=Math.min(input||0,Math.max(0,Number(usage?.input_tokens_details?.cached_tokens)||0));
 const cost=known?textCost(input,output,cached):row.kind==='audio'&&success?audioCost(row.audio_ms):providerAccepted?row.reserved_cost:0;
 const measured=row.kind==='audio'&&success?'pcm-duration':known?'provider-usage':providerAccepted?'upper-bound':'not-sent';
 const usedAudio=success?row.audio_ms:0,usedInput=success?(known?input:row.input_tokens):0,usedOutput=success?(known?output:row.output_tokens):0;
 const guard="EXISTS(SELECT 1 FROM service_requests WHERE id=? AND state='reserved')";
 await env.DB.batch([
  stmt(env,`UPDATE service_periods SET audio_reserved=MAX(0,audio_reserved-?),input_reserved=MAX(0,input_reserved-?),output_reserved=MAX(0,output_reserved-?),audio_used=audio_used+?,input_used=input_used+?,output_used=output_used+? WHERE account_id=? AND start=? AND ${guard}`,row.audio_ms,row.input_tokens,row.output_tokens,usedAudio,usedInput,usedOutput,row.account_id,row.period,row.id),
  stmt(env,`UPDATE plan_balances SET audio_reserved=MAX(0,audio_reserved-?),audio_used=audio_used+? WHERE account_id=? AND scope=? AND start=? AND ${guard}`,row.audio_ms,usedAudio,row.account_id,row.balance_scope,row.balance_start,row.id),
  stmt(env,`UPDATE service_budgets SET reserved=MAX(0,reserved-?),spent=spent+? WHERE month=? AND ${guard}`,row.reserved_cost,cost,row.month,row.id),
  stmt(env,"UPDATE service_requests SET state=?,cost=?,audio_ms=?,input_tokens=?,output_tokens=?,measurement=?,request_id=? WHERE id=? AND state='reserved'",success?'completed':'failed',cost,usedAudio,usedInput,usedOutput,measured,requestId,row.id)
 ]);
 await emitAlerts(env);
 const current=await stmt(env,'SELECT state FROM service_requests WHERE id=?',row.id).first();
 return current?.state==='completed';
}
export async function beginSummary(request,env,{id,inputHash}){
 await recoverExpired(env);const s=await requireService(request,env);
 const prior=await stmt(env,'SELECT * FROM service_summary_jobs WHERE id=?',id).first();
 if(prior&&(prior.account_id!==s.member.accountId||prior.input_hash!==inputHash))throw new MemberError('总结请求标识已使用，请重新发起。',409);
 const cached=await stmt(env,"SELECT * FROM service_summary_jobs WHERE account_id=? AND input_hash=? AND state='completed' ORDER BY created_at DESC LIMIT 1",s.member.accountId,inputHash).first();
 if(cached)return cached;
 if(s.plan.summaries===0)throw new MemberError('免费时长仅含翻译，课堂已保存；请开通会员使用总结。',402);
 const now=Date.now(),claim='reservation:'+crypto.randomUUID();
 await env.DB.batch([
  stmt(env,"DELETE FROM service_summary_jobs WHERE id=? AND account_id=? AND input_hash=? AND state='failed'",id,s.member.accountId,inputHash),
  stmt(env,`INSERT INTO service_summary_jobs (id,account_id,balance_scope,balance_start,input_hash,state,result,created_at,expires_at)
   SELECT ?,q.account_id,q.scope,q.start,?,'reserved',?,?,? FROM plan_balances q JOIN service_accounts a ON a.account_id=q.account_id JOIN service_settings s ON s.id='global'
   WHERE q.account_id=? AND q.scope=? AND q.start=? AND s.paused=0 AND a.restricted_until<=?
   AND (? IS NULL OR q.summaries_used+q.summaries_reserved<?)
   AND NOT EXISTS(SELECT 1 FROM service_summary_jobs j WHERE j.id=? OR (j.account_id=q.account_id AND j.input_hash=? AND j.state IN ('reserved','completed')))
   AND (SELECT COUNT(*) FROM service_summary_jobs j WHERE j.account_id=q.account_id AND j.state='reserved')<1`,id,inputHash,claim,now,now+20*60000,s.member.accountId,s.balance.scope,s.balance.start,now,s.plan.summaries,s.plan.summaries,id,inputHash),
  stmt(env,"UPDATE plan_balances SET summaries_reserved=summaries_reserved+1 WHERE account_id=? AND scope=? AND start=? AND EXISTS(SELECT 1 FROM service_summary_jobs WHERE id=? AND result=? AND state='reserved')",s.member.accountId,s.balance.scope,s.balance.start,id,claim)
 ]);
 const row=await stmt(env,'SELECT * FROM service_summary_jobs WHERE id=?',id).first();
 if(row?.state==='reserved'&&row.result===claim)return row;
 const completed=await stmt(env,"SELECT * FROM service_summary_jobs WHERE account_id=? AND input_hash=? AND state='completed' ORDER BY created_at DESC LIMIT 1",s.member.accountId,inputHash).first();
 if(completed)return completed;
 const duplicate=await stmt(env,"SELECT state FROM service_summary_jobs WHERE account_id=? AND state='reserved' LIMIT 1",s.member.accountId).first();
 throw new MemberError(duplicate?'已有总结正在生成，请等待完成后重试。':'本期 10 次总结额度已用完，请等待下期重置或升级金会员。',duplicate?409:402);
}
export async function finishSummary(env,row,{success=false,result=null}={}){
 await env.DB.batch([
  stmt(env,"UPDATE plan_balances SET summaries_reserved=MAX(0,summaries_reserved-1),summaries_used=summaries_used+? WHERE account_id=? AND scope=? AND start=? AND EXISTS(SELECT 1 FROM service_summary_jobs WHERE id=? AND state='reserved' AND result=?)",success?1:0,row.account_id,row.balance_scope,row.balance_start,row.id,row.result),
  stmt(env,"UPDATE service_summary_jobs SET state=?,result=? WHERE id=? AND state='reserved' AND result=?",success?'completed':'failed',success?result:null,row.id,row.result)
 ]);
}
export async function recoverExpired(env){
 const rows=(await stmt(env,"SELECT * FROM service_requests WHERE state='reserved' AND expires_at<=? LIMIT 20",Date.now()).all()).results;
 for(const row of rows)await settle(env,row,{providerAccepted:true});
 const jobs=(await stmt(env,"SELECT * FROM service_summary_jobs WHERE state='reserved' AND expires_at<=? LIMIT 20",Date.now()).all()).results;
 for(const row of jobs)await finishSummary(env,row,{success:false});
}
export async function serviceBudgetState(env){
 await recoverExpired(env);const config=await settings(env),month=monthAt();
 const totals=await stmt(env,'SELECT spent,reserved FROM service_budgets WHERE month=?',month).first()||{spent:0,reserved:0};
 return {month,timezone:'UTC',estimated:true,usdCny:USD_CNY,pricingVersion:PRICING_VERSION,spentCny:moneyCny(totals.spent),reservedCny:moneyCny(totals.reserved),warningCents:config.warning_cents,hardCents:config.hard_cents,paused:!!config.paused,quotaEnforced:true,limits:{trial:planFor('trial'),regular:planFor('regular'),premium:planFor('premium')},revision:config.revision};
}

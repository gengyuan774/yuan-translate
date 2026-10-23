import {MemberError} from './errors.js';
export {MemberError} from './errors.js';
import {accountUser,requireAccount} from './account-server.js';
import {combinedMembership} from './payment-rules.js';
const WEEK=7*86400;
// End of 2099 in Beijing time; the expiry is fixed, not extended on redemption.
const LONG_EXPIRY=Date.parse('2099-12-31T23:59:59.999+08:00');
const longCodeConfigured=env=>typeof env.MEMBER_LONG_CODE_SHA256==='string'&&/^[a-f0-9]{64}$/.test(env.MEMBER_LONG_CODE_SHA256);
const encode=new TextEncoder();
const db=env=>{if(!env.DB)throw new MemberError('会员服务暂不可用，请稍后重试。');return env.DB;};
export const sharedReady=env=>!!(env.OPENAI_API_KEY&&env.DB);
const configured=env=>{if(!env.MEMBER_CODE&&!longCodeConfigured(env))throw new MemberError('会员服务尚未配置，请联系管理员。');};
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const hash=async value=>hex(await crypto.subtle.digest('SHA-256',encode.encode(value)));
function sameDigest(aa,bb){let diff=aa.length^bb.length;for(let i=0;i<aa.length;i++)diff|=aa.charCodeAt(i)^bb.charCodeAt(i);return diff===0;}
async function matches(a,b){return sameDigest(await hash(a),await hash(b));}
export async function membershipFor(env,accountId){
 const row=await db(env).prepare('SELECT tier, expires_at FROM account_memberships WHERE account_id = ?').bind(accountId).first();
 const orders=(await db(env).prepare("SELECT tier,state,review_reason,grant_start,grant_end FROM payment_orders WHERE account_id=? AND state='paid'").bind(accountId).all()).results;
 return combinedMembership(row,orders);
}
export async function memberSession(request,env){
 const user=await accountUser(request,env);if(!user)return null;
 const membership=await membershipFor(env,user.id);return membership.active?{...membership,accountId:user.id}:null;
}
// SQLite performs the limit check and increment atomically, including across Worker instances.
export async function consume(env,id,limit,periodSeconds,amount=1,message){
 const now=Date.now(),window=Math.floor(now/(periodSeconds*1000));
 const result=await db(env).prepare('INSERT INTO usage_buckets (id, count, expires_at) SELECT ?, ?, ? WHERE ? <= ? ON CONFLICT(id) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ? RETURNING count').bind(id+':'+window,amount,(window+2)*periodSeconds*1000,amount,limit,limit).first();
 if(!result)throw new MemberError(message||'共享服务已达到使用上限，请稍后重试或联系管理员。',429);
}
export async function loginMember(request,env,code){
 const user=await requireAccount(request,env);configured(env);
 await consume(env,'redeem:'+user.id,15,600);
 await consume(env,'redeem-ip:'+await hash(request.headers.get('CF-Connecting-IP')||'unknown'),60,600);
 if(typeof code==='string'&&code.length<=128&&longCodeConfigured(env)&&sameDigest(await hash(code.trim()),env.MEMBER_LONG_CODE_SHA256))return redeemLongMembership(env,user);
 if(typeof code!=='string'||code.length>128||!env.MEMBER_CODE||!await matches(code.trim(),env.MEMBER_CODE))throw new MemberError('会员码不正确，请重新输入。',401);
 const now=Date.now(),version=await hash('member-code:'+env.MEMBER_CODE);
 // Persist the first expiry; retries and concurrent redemption never extend it.
 await db(env).batch([
  db(env).prepare('INSERT INTO member_redemptions (account_id, code_version, redeemed_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, code_version) DO NOTHING').bind(user.id,version,now,now+WEEK*1000),
  db(env).prepare(`INSERT INTO account_memberships (account_id, tier, expires_at, updated_at)
   SELECT account_id, 'regular', expires_at, ? FROM member_redemptions WHERE account_id = ? AND code_version = ? AND expires_at > ?
   ON CONFLICT(account_id) DO UPDATE SET tier = 'regular', expires_at = excluded.expires_at, updated_at = excluded.updated_at
   WHERE (account_memberships.tier != 'premium' OR account_memberships.expires_at <= ?) AND (account_memberships.expires_at IS NULL OR account_memberships.expires_at < excluded.expires_at)`).bind(now,user.id,version,now,now)
 ]);
 const membership=await membershipFor(env,user.id);
 if(!membership.active)throw new MemberError('此账户已领取过该会员码，7 天会员已到期。',409);
 return membership;
}
async function redeemLongMembership(env,user){
 const now=Date.now();if(now>=LONG_EXPIRY)throw new MemberError('此会员码已到期。',409);
 const version='long-premium:'+env.MEMBER_LONG_CODE_SHA256,auditId=crypto.randomUUID();
 // D1 runs the whole batch transactionally. Every mutation is conditional on
 // no previous redemption, so concurrent requests cannot double-grant rights.
 // A revoked membership cannot be restored by replaying an already-used code.
 await db(env).batch([
  db(env).prepare(`INSERT INTO security_audit (id,subject,actor,action,details,created_at)
   SELECT ?,?,'account','long_membership_redeemed',json_object('tier','premium','expiresAt',?,'previousTier',m.tier,'previousExpiresAt',m.expires_at),?
   FROM accounts a LEFT JOIN account_memberships m ON m.account_id=a.id
   WHERE a.id=? AND NOT EXISTS (SELECT 1 FROM member_redemptions WHERE account_id=? AND code_version=?)`).bind(auditId,await hash('audit:'+user.id),LONG_EXPIRY,now,user.id,user.id,version),
  db(env).prepare(`INSERT INTO account_memberships (account_id,tier,expires_at,updated_at)
   SELECT id,'premium',?,? FROM accounts WHERE id=? AND NOT EXISTS (SELECT 1 FROM member_redemptions WHERE account_id=? AND code_version=?)
   ON CONFLICT(account_id) DO UPDATE SET tier='premium',expires_at=MAX(COALESCE(account_memberships.expires_at,0),excluded.expires_at),updated_at=MAX(account_memberships.updated_at+1,excluded.updated_at)`).bind(LONG_EXPIRY,now,user.id,user.id,version),
  db(env).prepare('INSERT INTO member_redemptions (account_id,code_version,redeemed_at,expires_at) VALUES (?,?,?,?) ON CONFLICT(account_id,code_version) DO NOTHING').bind(user.id,version,now,LONG_EXPIRY)
 ]);
 if(!await db(env).prepare('SELECT id FROM security_audit WHERE id=?').bind(auditId).first())throw new MemberError('此账号已兑换过该会员码，每个账号限兑换一次。',409);
 return membershipFor(env,user.id);
}
const limit=(env,key,fallback)=>{const n=Number(env[key]);return Number.isSafeInteger(n)&&n>0?n:fallback;};
const realtimeLimits=(env,id)=>[
 {id:'realtime-minute:'+id,limit:3,period:60,message:'连接尝试过于频繁，请等待 1 分钟后重试。'},
 {id:'realtime-day',limit:limit(env,'MEMBER_DAILY_REALTIME_LIMIT',12),period:86400,message:'本站今天的实时连接次数已用完（所有会员共享），将在 UTC 00:00 恢复。请联系管理员调整连接上限。'}
];
export async function realtimeAvailability(request,env){
 const member=await memberSession(request,env);if(!member)throw new MemberError('请先登录并开通会员；已到期的会员无法使用共享服务。',401);
 if(!sharedReady(env))throw new MemberError('管理员尚未配置共享 API，请稍后再试。');
 for(const rule of realtimeLimits(env,member.accountId)){
  const window=Math.floor(Date.now()/(rule.period*1000));
  const row=await db(env).prepare('SELECT count FROM usage_buckets WHERE id = ?').bind(rule.id+':'+window).first();
  if((row?.count||0)>=rule.limit)return {available:false,code:rule.period===60?'connection_rate_limit':'daily_connection_limit',message:rule.message,retryAt:(window+1)*rule.period*1000};
 }
 return {available:true};
}
export async function allowSharedRequest(request,env,kind,characters=0){
 const member=await memberSession(request,env);if(!member)throw new MemberError('请先登录并开通会员；已到期的会员无法使用共享服务。',401);
 if(!sharedReady(env))throw new MemberError('会员已验证，管理员尚未配置共享 API，请稍后再试。');
 const id=member.accountId;
 if(kind==='token'){
  for(const rule of realtimeLimits(env,id))await consume(env,rule.id,rule.limit,rule.period,1,rule.message);
 }else{
  await consume(env,'text-minute:'+id,60,60);
  await consume(env,'text-day',limit(env,'MEMBER_DAILY_TEXT_LIMIT',3000),86400);
  await consume(env,'text-characters-day',limit(env,'MEMBER_DAILY_CHARACTER_LIMIT',5000000),86400,characters);
 }
 return env.OPENAI_API_KEY;
}

import {securityRate} from './security-common.js';
import {MemberError} from './errors.js';
import {membershipFor} from './member.js';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export async function requireMemberAdmin(request,env){
 await securityRate(request,env,'admin-auth','',120);
 const expected=env.MEMBER_ADMIN_TOKEN_SHA256;
 if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw new MemberError('会员管理接口未启用',503);
 const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 const actual=await digest(token||'');let diff=token?0:1;
 for(let i=0;i<64;i++)diff|=actual.charCodeAt(i)^expected.charCodeAt(i);
 if(diff)throw new MemberError('需要管理员凭据',401);
 if(!env.DB)throw new MemberError('会员服务暂不可用',503);
}
export async function adminMembership(env,username){
 if(typeof username!=='string'||! /^[a-z0-9_][a-z0-9_.-]{3,31}$/.test(username))throw new MemberError('账号格式不正确',400);
 const row=await env.DB.prepare(`SELECT a.id AS accountId, p.username, m.tier, m.expires_at AS expiresAt, m.updated_at AS updatedAt
  FROM account_passwords p JOIN accounts a ON a.id=p.account_id JOIN account_memberships m ON m.account_id=a.id WHERE p.username=?`).bind(username).first();
 if(!row)throw new MemberError('未找到账号或会员记录',404);
 return row;
}
export async function updateAdminMembership(env,data){
 const {username,accountId,tier,expiresAt,expectedUpdatedAt,reason}=data;
 if(Object.keys(data).some(k=>!['username','accountId','tier','expiresAt','expectedUpdatedAt','reason'].includes(k)))throw new MemberError('包含不支持的字段',400);
 if(!['none','regular','premium'].includes(tier)||!Number.isSafeInteger(expectedUpdatedAt)||typeof reason!=='string'||!reason.trim()||reason.length>300)throw new MemberError('会员参数不正确',400);
 const expiry=typeof expiresAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)?Date.parse(expiresAt):NaN;
 if(tier==='none'?expiresAt!==null:(!Number.isFinite(expiry)||new Date(expiry).toISOString()!==expiresAt||expiry<=Date.now()||expiry>Date.parse('2100-01-01T00:00:00.000Z')))throw new MemberError('会员到期时间不正确',400);
 const before=await adminMembership(env,username);
 if(before.accountId!==accountId||before.updatedAt!==expectedUpdatedAt)throw new MemberError('账号或会员状态已变化，请重新读取后再修改',409);
 const current=await membershipFor(env,accountId),now=Date.now();
 const id=crypto.randomUUID(),updatedAt=Math.max(now,expectedUpdatedAt+1),end=tier==='none'?null:expiry,anchor=tier==='none'?null:current.active?current.periodAnchor:now;
 // D1 batch is transactional: the audit and update both use the same expected revision.
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO membership_admin_audit (id, account_id, username, previous_tier, previous_expires_at, tier, expires_at, reason, created_at)
   SELECT ?, account_id, ?, tier, expires_at, ?, ?, ?, ? FROM account_memberships WHERE account_id=? AND updated_at=?`).bind(id,username,tier,end,reason.trim(),updatedAt,accountId,expectedUpdatedAt),
  env.DB.prepare('UPDATE account_memberships SET tier=?, expires_at=?, updated_at=?, quota_anchor=? WHERE account_id=? AND updated_at=?').bind(tier,end,updatedAt,anchor,accountId,expectedUpdatedAt)
 ]);
 const audit=await env.DB.prepare('SELECT id FROM membership_admin_audit WHERE id=?').bind(id).first();
 if(!audit)throw new MemberError('会员状态已变化，请重新读取后再修改',409);
 return {accountId,username,tier,expiresAt:end,updatedAt,auditId:id};
}

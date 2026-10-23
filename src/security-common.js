import {newPasswordError} from './password-policy.js';
import {MemberError} from './errors.js';
import {consume} from './member.js';
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export async function securityState(env,id){
 await env.DB.prepare("INSERT INTO account_security (account_id,status,version,updated_at) SELECT id,'active',0,? FROM accounts WHERE id=? ON CONFLICT(account_id) DO NOTHING").bind(Date.now(),id).run();
 const row=await env.DB.prepare('SELECT status,version FROM account_security WHERE account_id=?').bind(id).first();
 if(!row)throw new MemberError('账号不存在',401);return row;
}
export async function securityRate(request,env,action,id='',count=10){
 if(!env.DB)throw new MemberError('账户服务暂不可用',503);
 await env.DB.prepare('DELETE FROM usage_buckets WHERE id IN (SELECT id FROM usage_buckets WHERE expires_at<=? LIMIT 100)').bind(Date.now()).run();
 const ip=await digest(request.headers.get('CF-Connecting-IP')||'unknown');
 try{await consume(env,'security:'+action+':ip:'+ip,count,600);if(id)await consume(env,'security:'+action+':user:'+await digest(id),count,600);}catch(e){if(e.status===429)throw new MemberError('操作过于频繁，请稍后重试',429);throw e;}
}
export async function auditStatement(env,id,actor,action,details={}){return env.DB.prepare('INSERT INTO security_audit (id,subject,actor,action,details,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),await digest('audit:'+id),actor,action,JSON.stringify(details),Date.now());}
export function validPassword(value,username=''){const error=newPasswordError(value,username);if(error)throw new MemberError(error,400);return value;}

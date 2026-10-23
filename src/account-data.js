import {MemberError} from './errors.js';
import {requireAccount} from './account-server.js';
import {reauthenticate} from './account-security.js';
import {digest,randomToken,securityRate,auditStatement} from './security-common.js';
import {visibleOrder} from './payment-ledger.js';
export async function exportAccount(request,env,data){
 const {user}=await reauthenticate(request,env,data.currentPassword,'export');if(!env.BUCKET)throw new MemberError('文件服务暂不可用',503);
 const account=await env.DB.prepare('SELECT id,provider,label,phone_e164,created_at FROM accounts WHERE id=?').bind(user.id).first();
 const membership=await env.DB.prepare('SELECT tier,expires_at FROM account_memberships WHERE account_id=?').bind(user.id).first();
 const email=await env.DB.prepare('SELECT email,verified_at FROM recovery_emails WHERE account_id=?').bind(user.id).first();
 const redemptions=await env.DB.prepare('SELECT redeemed_at,expires_at FROM member_redemptions WHERE account_id=?').bind(user.id).all();
 await (await auditStatement(env,user.id,'account','personal_data_export_requested')).run();
 async function* lines(){
  yield {type:'account',formatVersion:1,exportedAt:new Date().toISOString(),account,membership,recoveryEmail:email,redemptions:redemptions.results};
  for(const [table,type] of [['account_classes','classroom'],['account_materials','material']]){
   let cursor='';
   while(true){
    await requireAccount(request,env);
    const rows=await env.DB.prepare(`SELECT object_key FROM ${table} WHERE account_id=? AND object_key>? ORDER BY object_key LIMIT 25`).bind(user.id,cursor).all();
    for(const row of rows.results){const obj=await env.BUCKET.get(row.object_key);if(!obj)throw new Error('导出文件缺失');yield {type,data:await obj.json()};cursor=row.object_key;}
    if(rows.results.length<25)break;
   }
  }
  let paymentCursor='';
  while(true){
   await requireAccount(request,env);
   const orders=(await env.DB.prepare('SELECT * FROM payment_orders WHERE account_id=? AND id>? ORDER BY id LIMIT 25').bind(user.id,paymentCursor).all()).results;
   for(const order of orders){const refunds=(await env.DB.prepare('SELECT id,amount,reason,state,created_at,updated_at FROM payment_refunds WHERE order_id=?').bind(order.id).all()).results;yield {type:'payment_order',data:{...visibleOrder(order),transactionId:order.transaction_id,refunds}};paymentCursor=order.id;}
   if(orders.length<25)break;
  }
  await requireAccount(request,env);
  await (await auditStatement(env,user.id,'account','personal_data_export_completed')).run();
  yield {type:'complete'};
 }
 const iterator=lines(),encoder=new TextEncoder();
 return new Response(new ReadableStream({async pull(controller){try{const {value,done}=await iterator.next();if(done)controller.close();else controller.enqueue(encoder.encode(JSON.stringify(value)+'\n'));}catch(e){controller.error(e);}},async cancel(){await iterator.return();}}),{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Content-Disposition':'attachment; filename="account-data.jsonl"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function startDeletion(request,env,data){
 if(data.confirmation!=='注销并删除')throw new MemberError('请输入“注销并删除”确认操作',400);
 const {user,version}=await reauthenticate(request,env,data.currentPassword,'delete-account');
 if(!env.BUCKET?.list)throw new MemberError('文件删除服务暂不可用',503);
 const id=data.deletionJobId||crypto.randomUUID(),token=data.deletionReceipt||randomToken(),auditId=crypto.randomUUID();
 if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new MemberError('删除凭据格式错误',400);
 await env.DB.batch([
  env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,'account','deletion_requested','{}',? FROM account_security WHERE account_id=? AND version=? AND status='active'").bind(auditId,await digest('audit:'+user.id),Date.now(),user.id,version),
  env.DB.prepare("INSERT INTO deletion_jobs (id,account_id,token_hash,status,created_at) SELECT ?,account_id,?,'pending',? FROM account_security WHERE account_id=? AND version=? AND status='active'").bind(id,await digest(token),Date.now(),user.id,version),
  env.DB.prepare("UPDATE account_security SET status='deleting',version=version+1,updated_at=? WHERE account_id=? AND version=? AND status='active'").bind(Date.now(),user.id,version),
  env.DB.prepare('DELETE FROM account_sessions WHERE account_id=? AND EXISTS (SELECT 1 FROM deletion_jobs WHERE id=?)').bind(user.id,id)
 ]);
 if(!await env.DB.prepare('SELECT id FROM deletion_jobs WHERE id=?').bind(id).first())throw new MemberError('账户状态已变化，请重试',409);
 // The receipt authorizes only resuming this irreversible deletion, not access to account data.
 return {jobId:id,receipt:token,status:'pending'};
}
export async function resumeDeletion(request,env,data,admin=false){
 if(!admin)await securityRate(request,env,'deletion-status','',30);
 const row=await env.DB.prepare('SELECT * FROM deletion_jobs WHERE id=?').bind(String(data.jobId||'')).first();
 if(!row||(!admin&&(typeof data.receipt!=='string'||row.token_hash!==await digest(data.receipt))))throw new MemberError('删除凭据无效',404);
 if(row.status==='completed')return {status:'completed'};
 // Wait for already-authorized requests (up to 60 seconds) to finish before removing all objects.
 if(Date.now()-row.created_at<90000)return {status:'pending',retryAfter:5};
 if(!env.BUCKET?.list)throw new MemberError('删除服务暂不可用，请保留回执重试',503);
 const objects=await env.BUCKET.list({prefix:`accounts/${row.account_id}/`,limit:100});
 for(const obj of objects.objects)await env.BUCKET.delete(obj.key);
 if(objects.objects.length)return {status:'pending',retryAfter:1};
 const id=row.account_id,subject=await digest('audit:'+id),statements=[];
 statements.push(env.DB.prepare("INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,?,'deletion_completed','{}',? FROM deletion_jobs WHERE id=? AND status='pending'").bind(crypto.randomUUID(),subject,admin?'admin':'account',Date.now(),row.id));
 for(const table of ['account_materials','account_classes','account_sessions','account_passwords','account_memberships','member_redemptions','membership_admin_audit','recovery_emails','recovery_challenges','account_security'])statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(id));
 statements.push(env.DB.prepare("UPDATE security_audit SET details='{}' WHERE subject=?").bind(subject));
 statements.push(env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(id));
 statements.push(env.DB.prepare("UPDATE deletion_jobs SET account_id=NULL,status='completed',completed_at=? WHERE id=?").bind(Date.now(),row.id));
 await env.DB.batch(statements);return {status:'completed'};
}

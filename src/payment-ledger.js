import {MemberError} from './errors.js';
import {digest} from './security-common.js';
import {scheduleGrants} from './payment-rules.js';
const validId=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
export async function paymentOrder(env,id){
 if(!validId(id))throw new MemberError('订单不存在',404);
 const row=await env.DB.prepare('SELECT * FROM payment_orders WHERE id=?').bind(id).first();
 if(!row)throw new MemberError('订单不存在',404);return row;
}
export const paidOrders=async(env,id)=>(await env.DB.prepare("SELECT * FROM payment_orders WHERE account_id=? AND state='paid' ORDER BY sequence,id").bind(id).all()).results;
export function validatePayment(order,fact,env){
 if(fact?.out_trade_no!==order.id||fact.mchid!==order.merchant_id||fact.mchid!==env.WECHATPAY_MCH_ID||fact.appid!==order.app_id||fact.trade_type!=='NATIVE'||!['SUCCESS','REFUND'].includes(fact.trade_state)||fact.amount?.total!==order.amount||fact.amount?.currency!==order.currency||typeof fact.transaction_id!=='string'||!/^[a-zA-Z0-9_-]{6,64}$/.test(fact.transaction_id)||!Number.isFinite(Date.parse(fact.success_time)))throw new MemberError('支付信息与订单不匹配，暂不发放权益，请联系客服核对。',409);
 if(order.transaction_id&&fact.transaction_id!==order.transaction_id)throw new MemberError('支付交易号与已确认订单不一致',409);
}
function normalizeRefund(order,fact,env){
 const state=String(fact.refund_status||fact.status||'').toLowerCase();
 if(fact.out_trade_no!==order.id||fact.mchid!==order.merchant_id||fact.mchid!==env.WECHATPAY_MCH_ID||fact.transaction_id!==order.transaction_id||!['success','processing','closed','abnormal'].includes(state)||typeof fact.out_refund_no!=='string'||!/^[a-zA-Z0-9_\-|*@]{1,64}$/.test(fact.out_refund_no)||!Number.isSafeInteger(fact.amount?.refund)||fact.amount.refund<1||fact.amount.refund>order.amount||fact.amount.total!==order.amount||fact.amount.currency!==order.currency||typeof fact.refund_id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(fact.refund_id))throw new MemberError('退款信息与订单不匹配，请核对。',409);
 return {id:fact.out_refund_no,order_id:order.id,amount:fact.amount.refund,state,provider_id:fact.refund_id};
}
function factHash(payment,refund){return digest(JSON.stringify({transaction:payment.transaction_id,total:payment.amount.total,currency:payment.amount.currency,refund:refund?{id:refund.id,amount:refund.amount,state:refund.state}:null}));}
async function checkEvent(env,event,order,hash){
 if(!event)return false;
 const existing=await env.DB.prepare('SELECT * FROM payment_events WHERE id=?').bind(event.id).first();
 if(existing&&(existing.order_id!==order.id||existing.kind!==event.kind||existing.payload_hash!==hash))throw new MemberError('支付通知编号与内容不一致',409);
 return !!existing;
}
async function saveDuplicateEvent(env,event,order,hash){
 if(!event||await checkEvent(env,event,order,hash))return;
 await env.DB.prepare('INSERT INTO payment_events (id,order_id,kind,payload_hash,created_at) VALUES (?,?,?,?,?)').bind(event.id,order.id,event.kind,hash,Date.now()).run();
}
// All grants, refund adjustments, audit entries and event receipts share a D1
// transaction. An account version serializes concurrent orders and refunds.
export async function applyPaymentFacts(env,id,payment,{refund:rawRefund,event=null,actor='payment-provider'}={}){
 for(let attempt=0;attempt<8;attempt++){
  const order=await paymentOrder(env,id);validatePayment(order,payment,env);
  const candidate={...order,state:'paid',transaction_id:payment.transaction_id,paid_at:Date.parse(payment.success_time)};
  const refund=rawRefund?normalizeRefund(candidate,rawRefund,env):null,hash=await factHash(payment,refund);
  if(await checkEvent(env,event,order,hash))return order;
  const previousRefund=refund?await env.DB.prepare('SELECT * FROM payment_refunds WHERE id=?').bind(refund.id).first():null;
  if(previousRefund&&(previousRefund.order_id!==id||previousRefund.amount!==refund.amount))throw new MemberError('退款编号或金额不一致',409);
  const refundUnchanged=refund&&previousRefund&&(previousRefund.state==='success'||(previousRefund.state==='closed'&&refund.state!=='success')||(previousRefund.state===refund.state&&previousRefund.provider_id===refund.provider_id));
  if(order.state==='paid'&&(!refund||refundUnchanged)){
   await saveDuplicateEvent(env,event,order,hash);return order;
  }
  const now=Date.now(),token=crypto.randomUUID(),owner=order.account_id;
  // Older sessions can predate the security table. Preserve the same active
  // default used by account authentication without recreating a deleted owner.
  if(owner)await env.DB.prepare("INSERT INTO account_security (account_id,status,version,updated_at) SELECT id,'active',0,? FROM accounts WHERE id=? ON CONFLICT(account_id) DO NOTHING").bind(now,owner).run();
  const state=owner?await env.DB.prepare('SELECT status FROM account_security WHERE account_id=?').bind(owner).first():null;
  const eligible=!!owner&&state&&state.status!=='deleting';
  if(eligible)await env.DB.prepare('INSERT INTO payment_accounts (account_id,version) VALUES (?,0) ON CONFLICT(account_id) DO NOTHING').bind(owner).run();
  const account=eligible?await env.DB.prepare('SELECT version FROM payment_accounts WHERE account_id=?').bind(owner).first():null;
  const base=eligible?await env.DB.prepare('SELECT * FROM account_memberships WHERE account_id=?').bind(owner).first():null;
  const sum=await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM payment_refunds WHERE order_id=? AND state='success' AND id!=?").bind(id,refund?.id||'').first();
  candidate.refunded_amount=refund?sum.total+(previousRefund?.state==='success'||refund.state==='success'?refund.amount:0):order.refunded_amount;
  if(candidate.refunded_amount>candidate.amount)throw new MemberError('累计退款超出订单金额',409);
  candidate.review_reason=eligible?null:'account_closed';
  if(order.state!=='paid'){
   candidate.sequence=(account?.version||0)+1;
   candidate.floor_start=Math.max(now,base?.tier!=='none'&&base?.expires_at>now?base.expires_at:now);
   if(payment.trade_state==='REFUND'&&!refund)candidate.review_reason='refund_status_review';
  }else candidate.review_reason=refund&&['refund_status_review','membership_period_review'].includes(order.review_reason)?null:order.review_reason;
  let timeline=[];
  if(eligible&&candidate.review_reason===null){
   const others=(await paidOrders(env,owner)).filter(o=>o.id!==id&&o.review_reason===null);
   try{timeline=scheduleGrants([...others,candidate],now);Object.assign(candidate,timeline.find(o=>o.id===id));}
   catch{candidate.review_reason='membership_period_review';candidate.grant_start=null;candidate.grant_end=null;timeline=[];}
  }
  if(!eligible){candidate.grant_start=null;candidate.grant_end=null;}
  const condition=eligible?" AND EXISTS(SELECT 1 FROM payment_accounts p JOIN account_security s ON s.account_id=p.account_id WHERE p.account_id=? AND p.version=? AND s.status!='deleting')":'';
  const args=[candidate.transaction_id,candidate.paid_at,candidate.refunded_amount,candidate.sequence,candidate.floor_start,candidate.grant_start,candidate.grant_end,candidate.review_reason,token,id,order.revision,owner];
  if(eligible)args.push(owner,account.version);
  const statements=[env.DB.prepare("UPDATE payment_orders SET state='paid',transaction_id=?,paid_at=?,refunded_amount=?,sequence=?,floor_start=?,grant_start=?,grant_end=?,review_reason=?,revision=revision+1,mutation_token=? WHERE id=? AND revision=? AND account_id IS ?"+condition).bind(...args)];
  const applied='EXISTS(SELECT 1 FROM payment_orders WHERE id=? AND mutation_token=?)';
  if(refund&&!refundUnchanged)statements.push(env.DB.prepare(`INSERT INTO payment_refunds (id,order_id,request_id,amount,reason,state,provider_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${applied} ON CONFLICT(id) DO UPDATE SET state=excluded.state,provider_id=excluded.provider_id,updated_at=excluded.updated_at`).bind(refund.id,id,previousRefund?.request_id||'external:'+refund.id,refund.amount,previousRefund?.reason||'微信平台退款',previousRefund?.state==='success'?'success':refund.state,refund.provider_id,previousRefund?.created_at||now,now,id,token));
  for(const other of timeline.filter(o=>o.id!==id))statements.push(env.DB.prepare(`UPDATE payment_orders SET grant_start=?,grant_end=?,revision=revision+1 WHERE id=? AND ${applied}`).bind(other.grant_start,other.grant_end,other.id,id,token));
  if(event)statements.push(env.DB.prepare(`INSERT INTO payment_events (id,order_id,kind,payload_hash,created_at) SELECT ?,?,?,?,? WHERE ${applied}`).bind(event.id,id,event.kind,hash,now,id,token));
  statements.push(env.DB.prepare(`INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,?,?,?,? WHERE ${applied}`).bind(crypto.randomUUID(),await digest('audit:'+(owner||'order:'+id)),actor,refund?'payment_refund_updated':'payment_confirmed',JSON.stringify({orderId:id,amount:order.amount,currency:order.currency,refundId:refund?.id||null,refundedAmount:candidate.refunded_amount,reviewReason:candidate.review_reason}),now,id,token));
  if(eligible)statements.push(env.DB.prepare(`UPDATE payment_accounts SET version=version+1 WHERE account_id=? AND version=? AND ${applied}`).bind(owner,account.version,id,token));
  await env.DB.batch(statements);
  const after=await paymentOrder(env,id);if(after.mutation_token===token)return after;
 }
 throw new MemberError('订单正在更新，请稍后查单。',503);
}
export function visibleOrder(order){
 return {id:order.id,planId:order.plan_id,tier:order.tier,amount:order.amount,currency:order.currency,state:order.state,refundedAmount:order.refunded_amount,createdAt:order.created_at,expiresAt:order.expires_at,paidAt:order.paid_at,grantStart:order.grant_start,grantEnd:order.grant_end,needsReview:!!order.review_reason,codeUrl:order.state!=='paid'&&order.expires_at>Date.now()?order.code_url:null};
}

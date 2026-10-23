import {requireAccount} from './account-server.js';
import {MemberError} from './errors.js';
import {securityRate,auditStatement,digest} from './security-common.js';
import {PAYMENT_PLANS,scheduleGrants} from './payment-rules.js';
import {paymentReady,requirePayments,wechatConfigured,wechatCall,queryWechat,verifyWechat,decryptWechat} from './wechat-pay.js';
import {paymentOrder,paidOrders,applyPaymentFacts,visibleOrder} from './payment-ledger.js';
const uid=()=>Date.now().toString(16).padStart(12,'0')+Array.from(crypto.getRandomValues(new Uint8Array(10)),b=>b.toString(16).padStart(2,'0')).join('');
const requestId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const only=(data,fields)=>{if(!data||Object.keys(data).some(k=>!fields.includes(k)))throw new MemberError('订单参数不正确',400);};
export const paymentConfig=env=>({enabled:paymentReady(env),provider:'wechat-native',plans:Object.values(PAYMENT_PLANS),periodDays:30,automaticRenewal:false});
export async function ownPaymentOrder(request,env,id){
 const user=await requireAccount(request,env),order=await paymentOrder(env,id);
 if(order.account_id!==user.id)throw new MemberError('订单不存在',404);return {user,order};
}
export async function orderDetails(env,order,admin=false){
 const refunds=(await env.DB.prepare('SELECT id,amount,state,created_at,updated_at FROM payment_refunds WHERE order_id=? ORDER BY created_at DESC').bind(order.id).all()).results;
 let estimate={};
 if(order.state!=='paid'&&order.account_id){
  const base=await env.DB.prepare('SELECT * FROM account_memberships WHERE account_id=?').bind(order.account_id).first(),existing=(await paidOrders(env,order.account_id)).filter(o=>o.review_reason===null),now=Date.now();
  try{const next=scheduleGrants([...existing,{...order,sequence:Math.max(0,...existing.map(o=>o.sequence||0))+1,floor_start:Math.max(now,base?.tier!=='none'&&base?.expires_at>now?base.expires_at:now)}],now).find(o=>o.id===order.id);estimate={estimatedStart:next.grant_start,estimatedEnd:next.grant_end};}catch{estimate={purchaseUnavailable:true};}
 }
 return {...visibleOrder(order),...estimate,refunds,...(admin?{accountId:order.account_id,transactionId:order.transaction_id,reviewReason:order.review_reason,revision:order.revision}:{} )};
}
async function checkoutCode(env,order,upstream){
 if(order.state==='paid'||order.state==='closed'||order.expires_at<=Date.now())return order;
 const reply=await wechatCall(env,'POST','/v3/pay/transactions/native',{appid:order.app_id,mchid:order.merchant_id,description:'满绩速翻 · '+PAYMENT_PLANS[order.plan_id].label+' · 30天',out_trade_no:order.id,time_expire:new Date(order.expires_at).toISOString().replace(/\.\d{3}Z$/,'+00:00'),notify_url:new URL('/api/payments/wechat/notify',env.PAYMENTS_PUBLIC_ORIGIN).href,amount:{total:order.amount,currency:order.currency}},upstream);
 if(typeof reply.code_url!=='string'||!/^weixin:\/\/wxpay\/bizpayurl(?:\/up)?\?/.test(reply.code_url)||reply.code_url.length>512)throw new MemberError('支付二维码暂时无法生成，请稍后查单。',503);
 await env.DB.prepare("UPDATE payment_orders SET code_url=?,state='pending',revision=revision+1 WHERE id=? AND state IN ('created','pending')").bind(reply.code_url,order.id).run();
 return paymentOrder(env,order.id);
}
export async function createPaymentOrder(request,env,data,upstream){
 const user=await requireAccount(request,env);requirePayments(env);only(data,['planId','requestId']);
 const plan=Object.hasOwn(PAYMENT_PLANS,data.planId)?PAYMENT_PLANS[data.planId]:null;
 if(!plan||!requestId(data.requestId))throw new MemberError('请选择有效套餐',400);
 await securityRate(request,env,'payment-create',user.id,12);
 let order=await env.DB.prepare('SELECT * FROM payment_orders WHERE account_id=? AND request_id=?').bind(user.id,data.requestId).first();
 if(order&&order.plan_id!==plan.id)throw new MemberError('此下单请求已用于其他套餐，请重新选择。',409);
 if(!order){
  const now=Date.now(),base=await env.DB.prepare('SELECT * FROM account_memberships WHERE account_id=?').bind(user.id).first(),timeline=await paidOrders(env,user.id);
  try{scheduleGrants([...timeline.filter(o=>o.review_reason===null),{id:'quote',amount:plan.amount,refunded_amount:0,duration_ms:plan.durationMs,sequence:Math.max(0,...timeline.map(o=>o.sequence||0))+1,floor_start:Math.max(now,base?.tier!=='none'&&base?.expires_at>now?base.expires_at:now),grant_start:null,grant_end:null}],now);}catch{throw new MemberError('当前会员有效期已较长，无需重复购买。',409);}
  const id=uid();await env.DB.prepare("INSERT INTO payment_orders (id,account_id,request_id,plan_id,tier,amount,currency,duration_ms,merchant_id,app_id,state,refunded_amount,created_at,expires_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,'created',0,?,?,0) ON CONFLICT(account_id,request_id) DO NOTHING").bind(id,user.id,data.requestId,plan.id,plan.tier,plan.amount,plan.currency,plan.durationMs,env.WECHATPAY_MCH_ID,env.WECHATPAY_APP_ID,now,now+30*60000).run();
  order=await env.DB.prepare('SELECT * FROM payment_orders WHERE account_id=? AND request_id=?').bind(user.id,data.requestId).first();
 }
 if(order.plan_id!==plan.id)throw new MemberError('此下单请求已用于其他套餐',409);
 try{order=await checkoutCode(env,order,upstream);}catch(e){return {order:await orderDetails(env,await paymentOrder(env,order.id)),warning:e instanceof MemberError?e.message:'支付平台尚未确认下单，请稍后查单。'};}
 return {order:await orderDetails(env,order)};
}
export async function reconcilePayment(env,order,upstream,actor='payment-reconcile'){
 const fact=await queryWechat(env,order.id,upstream);
 if(['SUCCESS','REFUND'].includes(fact.trade_state))return applyPaymentFacts(env,order.id,fact,{actor});
 if(fact.out_trade_no!==order.id||fact.mchid!==order.merchant_id||fact.appid!==order.app_id)throw new MemberError('查单结果与订单不匹配',409);
 if(fact.trade_state==='NOTPAY'&&order.expires_at<=Date.now()&&['created','pending'].includes(order.state)){
  await wechatCall(env,'POST','/v3/pay/transactions/out-trade-no/'+order.id+'/close',{mchid:order.merchant_id},upstream);
  const after=await queryWechat(env,order.id,upstream);
  if(['SUCCESS','REFUND'].includes(after.trade_state))return applyPaymentFacts(env,order.id,after,{actor});
  if(after.out_trade_no!==order.id||after.mchid!==order.merchant_id||after.appid!==order.app_id||after.trade_state!=='CLOSED')throw new MemberError('订单关闭状态尚未确认，请稍后查单。',503);
  await env.DB.prepare("UPDATE payment_orders SET state='closed',revision=revision+1 WHERE id=? AND state IN ('created','pending')").bind(order.id).run();
 }
 if(['CLOSED','REVOKED','PAYERROR'].includes(fact.trade_state))await env.DB.prepare("UPDATE payment_orders SET state='closed',revision=revision+1 WHERE id=? AND state IN ('created','pending')").bind(order.id).run();
 return paymentOrder(env,order.id);
}
export async function paymentWebhook(request,env,upstream){
 if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
 if(!wechatConfigured(env))throw new MemberError('支付通知服务尚未配置',503);
 if(Number(request.headers.get('content-length'))>65536)throw new MemberError('通知过大',413);
 const reader=request.body?.getReader();if(!reader)throw new MemberError('通知为空',400);const chunks=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new MemberError('通知过大',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const raw=new TextDecoder().decode(bytes);await verifyWechat(request.headers,raw,env);
 await securityRate(request,env,'payment-webhook','',600);
 let body;try{body=JSON.parse(raw);}catch{throw new MemberError('通知格式不正确',400);}
 if(typeof body.id!=='string'||body.id.length>128||!body.id)throw new MemberError('通知编号无效',400);
 const event={id:body.id,kind:body.event_type};
 if(!['TRANSACTION.SUCCESS','REFUND.SUCCESS','REFUND.CLOSED','REFUND.ABNORMAL'].includes(event.kind))return new Response(null,{status:204});
 const fact=await decryptWechat(body.resource,env),order=await paymentOrder(env,fact.out_trade_no);
 if(event.kind==='TRANSACTION.SUCCESS'){
  if(fact.trade_state!=='SUCCESS')throw new MemberError('支付通知状态不一致',409);
  await applyPaymentFacts(env,order.id,fact,{event});
 }else{
  if(event.kind!=='REFUND.'+fact.refund_status)throw new MemberError('退款通知状态不一致',409);
  const paid=await queryWechat(env,order.id,upstream);await applyPaymentFacts(env,order.id,paid,{refund:fact,event});
 }
 return new Response(null,{status:204});
}
export async function userPayments(request,env,path,data,upstream){
 const user=await requireAccount(request,env);
 if(path==='/api/payments/orders'&&request.method==='POST')return createPaymentOrder(request,env,data,upstream);
 if(path==='/api/payments/orders'&&request.method==='GET'){
  const url=new URL(request.url),before=url.searchParams.get('before')||'z';if(!/^(z|[a-f0-9]{32})$/.test(before))throw new MemberError('分页参数不正确',400);
  const rows=(await env.DB.prepare('SELECT * FROM payment_orders WHERE account_id=? AND id<? ORDER BY id DESC LIMIT 25').bind(user.id,before).all()).results;
  return {orders:rows.map(visibleOrder),next:rows.length===25?rows.at(-1).id:null};
 }
 const match=path.match(/^\/api\/payments\/orders\/([a-f0-9]{32})(\/check)?$/);if(!match)throw new MemberError('订单不存在',404);
 const {order}=await ownPaymentOrder(request,env,match[1]);
 if(!match[2]&&request.method==='GET')return {order:await orderDetails(env,order)};
 if(match[2]&&request.method==='POST'){
  await securityRate(request,env,'payment-check',user.id,30);const {consume}=await import('./member.js');await consume(env,'payment-check-order:'+order.id,2,60,1,'请稍后再查单。');
  let after=await reconcilePayment(env,order,upstream);
  after=await reconcileKnownRefunds(env,after,upstream);
  return {order:await orderDetails(env,after)};
 }
 throw new MemberError('不支持此订单操作',405);
}
async function reconcileKnownRefunds(env,order,upstream){
 const pending=(await env.DB.prepare("SELECT * FROM payment_refunds WHERE order_id=? AND state IN ('created','processing','abnormal') ORDER BY updated_at LIMIT 5").bind(order.id).all()).results;
 for(const refund of pending)order=await reconcileRefund(env,order,refund.id,upstream);
 return order;
}
export async function reconcileRefund(env,order,refundId,upstream){
 if(typeof refundId!=='string'||!/^[a-zA-Z0-9_\-|*@]{1,64}$/.test(refundId))throw new MemberError('退款编号无效',400);
 const fact=await wechatCall(env,'GET','/v3/refund/domestic/refunds/'+encodeURIComponent(refundId),undefined,upstream);
 if(fact.out_refund_no!==refundId||fact.out_trade_no!==order.id)throw new MemberError('退款编号不一致',409);
 const paid=await queryWechat(env,order.id,upstream);return applyPaymentFacts(env,order.id,paid,{refund:{...fact,mchid:fact.mchid??env.WECHATPAY_MCH_ID},actor:'payment-reconcile'});
}
export async function requestRefund(env,data,upstream){
 only(data,['orderId','amount','requestId','reason']);
 if(!requestId(data.requestId)||!Number.isSafeInteger(data.amount)||data.amount<1||typeof data.reason!=='string'||!data.reason.trim()||new TextEncoder().encode(data.reason).length>80)throw new MemberError('请提供退款金额（分）、请求编号和退款原因',400);
 let order=await paymentOrder(env,data.orderId);order=await reconcilePayment(env,order,upstream,'admin');
 if(order.state!=='paid')throw new MemberError('订单尚未确认付款，不能退款',409);
 let refund=await env.DB.prepare('SELECT * FROM payment_refunds WHERE order_id=? AND request_id=?').bind(order.id,data.requestId).first();
 if(refund&&(refund.amount!==data.amount||refund.reason!==data.reason.trim()))throw new MemberError('同一退款请求的金额或原因不能改变',409);
 if(!refund){
  const id=uid(),now=Date.now();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO payment_refunds (id,order_id,request_id,amount,reason,state,created_at,updated_at) SELECT ?,?,?,?,?,'created',?,? WHERE ?<=(SELECT amount-COALESCE((SELECT SUM(amount) FROM payment_refunds WHERE order_id=? AND state IN ('created','processing','success','abnormal')),0) FROM payment_orders WHERE id=? AND state='paid') ON CONFLICT(order_id,request_id) DO NOTHING").bind(id,order.id,data.requestId,data.amount,data.reason.trim(),now,now,data.amount,order.id,order.id),
   env.DB.prepare('INSERT INTO security_audit (id,subject,actor,action,details,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_refunds WHERE id=?)').bind(crypto.randomUUID(),await digest('audit:'+(order.account_id||'order:'+order.id)),'admin','payment_refund_requested',JSON.stringify({orderId:order.id,refundId:id,amount:data.amount,reason:data.reason.trim()}),now,id)
  ]);
  refund=await env.DB.prepare('SELECT * FROM payment_refunds WHERE order_id=? AND request_id=?').bind(order.id,data.requestId).first();if(!refund)throw new MemberError('可退款余额不足或已有退款处理中',409);
 }
 if(refund.amount!==data.amount||refund.reason!==data.reason.trim())throw new MemberError('同一退款请求的金额或原因不能改变',409);
 if(refund.state!=='created')return {order:await orderDetails(env,order,true),refund};
 const fact=await wechatCall(env,'POST','/v3/refund/domestic/refunds',{transaction_id:order.transaction_id,out_refund_no:refund.id,reason:refund.reason,notify_url:new URL('/api/payments/wechat/notify',env.PAYMENTS_PUBLIC_ORIGIN).href,amount:{refund:refund.amount,total:order.amount,currency:order.currency}},upstream);
 // Acceptance is not success. Only a signed SUCCESS response or later query
 // changes the order's refundable balance and remaining membership period.
 if(fact.out_refund_no!==refund.id||fact.out_trade_no!==order.id)throw new MemberError('退款应答与申请不一致，请查单确认。',409);
 const normalized={...fact,mchid:fact.mchid??env.WECHATPAY_MCH_ID};
 order=await applyPaymentFacts(env,order.id,await queryWechat(env,order.id,upstream),{refund:normalized,actor:'admin'});
 return {order:await orderDetails(env,order,true),refund:await env.DB.prepare('SELECT * FROM payment_refunds WHERE id=?').bind(refund.id).first()};
}
export async function adminPayments(request,env,path,data,upstream){
 const url=new URL(request.url);
 if(path==='/api/admin/payments'&&request.method==='GET'){
  const before=url.searchParams.get('before')||'z';if(!/^(z|[a-f0-9]{32})$/.test(before))throw new MemberError('分页参数不正确',400);
  const rows=(await env.DB.prepare('SELECT * FROM payment_orders WHERE id<? ORDER BY id DESC LIMIT 25').bind(before).all()).results;
  const summary=await env.DB.prepare("SELECT COUNT(*) orders,COALESCE(SUM(CASE WHEN state='paid' THEN amount ELSE 0 END),0) paidAmount,COALESCE(SUM(refunded_amount),0) refundedAmount,SUM(CASE WHEN review_reason IS NOT NULL THEN 1 ELSE 0 END) reviewOrders FROM payment_orders").bind().first();
  return {orders:rows.map(o=>({...visibleOrder(o),accountId:o.account_id,reviewReason:o.review_reason})),summary,next:rows.length===25?rows.at(-1).id:null};
 }
 if(path==='/api/admin/payments/refund'&&request.method==='POST')return requestRefund(env,data,upstream);
 const match=path.match(/^\/api\/admin\/payments\/([a-f0-9]{32})(?:\/(reconcile|refund-query))?$/);if(!match)throw new MemberError('订单不存在',404);
 let order=await paymentOrder(env,match[1]);
 if(request.method==='GET'&&!match[2])return orderDetails(env,order,true);
 if(request.method==='POST'&&match[2]){
  if(typeof data?.reason!=='string'||!data.reason.trim()||data.reason.length>300)throw new MemberError('请提供操作原因',400);
  if(match[2]==='refund-query')order=await reconcileRefund(env,order,data.refundId,upstream);else order=await reconcileKnownRefunds(env,await reconcilePayment(env,order,upstream,'admin'),upstream);
  await (await auditStatement(env,order.account_id||'order:'+order.id,'admin','payment_reconciled',{orderId:order.id,reason:data.reason.trim(),state:order.state,refundId:data.refundId||null})).run();
  return orderDetails(env,order,true);
 }
 throw new MemberError('不支持此管理操作',405);
}

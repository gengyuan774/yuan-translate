import qrcode from 'qrcode-generator';
import {escapeHtml as escape} from '../public/format.js';
const $=id=>document.getElementById(id),view=document.body.dataset.paymentView;
let user=null,enabled=false,busy=false,next=null,poll=null,currentOrder=null;
const money=amount=>'¥'+(amount/100).toFixed(2),date=value=>value?new Date(value).toLocaleString('zh-CN'):'待确认';
const label=tier=>tier==='premium'?'金会员':'普通会员';
const refundLabel=state=>({created:'申请待确认',processing:'平台处理中',success:'退款成功',closed:'退款已关闭',abnormal:'退款异常，需客服处理'})[state]||'待核对';
function state(order){
 if(order.state==='paid'){
  if(order.refundedAmount>=order.amount)return '已全额退款';
  if(order.needsReview)return '付款已确认，权益待核对';
  if(order.refunds?.some(r=>['created','processing','abnormal'].includes(r.state)))return '退款处理中';
  if(order.refundedAmount>0)return '已部分退款';
  if(order.grantStart>Date.now())return '已付款，等待生效';
  return order.grantEnd>Date.now()?'已付款，会员已生效':'订单已完成';
 }
 return order.state==='closed'?'订单已关闭':order.expiresAt<Date.now()?'支付时间已过，待查单确认':'等待付款';
}
function message(text){$('payment-message').textContent=text;}
async function api(path,body){
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});
 const data=await response.json();if(!response.ok){const error=new Error(data.error?.message||'暂时无法读取支付信息');error.status=response.status;throw error;}return data;
}
function loginNeeded(){message('请先登录保存订单的账号，再继续购买或查看订单。');$('payment-login').hidden=false;}
async function loadOrders(){
 if(busy)return;busy=true;$('orders-more').disabled=true;
 try{const data=await api('/api/payments/orders'+(next?'?before='+next:''));
  for(const order of data.orders){const a=document.createElement('a');a.className='order-item';a.href='/membership/pay?order='+order.id;
   a.innerHTML=`<div class="order-item-header"><strong>${escape(label(order.tier))} · ${money(order.amount)}</strong><span class="order-state">${escape(state(order))}</span></div><p>订单号：${escape(order.id)}<br>创建时间：${escape(date(order.createdAt))}${order.grantStart?'<br>权益时间：'+escape(date(order.grantStart))+' 至 '+escape(date(order.grantEnd)):''}</p>`;
   $('orders-list').append(a);
  }
  next=data.next;$('orders-more').hidden=!next;message($('orders-list').children.length?'订单由后台确认到账后更新，点击查看详情。':'当前账号还没有在线支付订单。会员码和人工赠送记录不属于支付订单。');
 }catch(e){message(e.message);}finally{busy=false;$('orders-more').disabled=false;}
}
function renderCheckout(order){
 currentOrder=order;$('checkout-card').hidden=false;
 $('checkout-details').innerHTML=`<h2>${escape(label(order.tier))} · ${money(order.amount)}</h2><dl><dt>订单状态</dt><dd>${escape(state(order))}</dd><dt>订单编号</dt><dd>${escape(order.id)}</dd><dt>计费周期</dt><dd>每期 30 天，不自动续费</dd><dt>${order.state==='paid'?'生效时间':'预计生效'}</dt><dd>${escape(date(order.grantStart||order.estimatedStart))}</dd><dt>${order.state==='paid'?'到期时间':'预计到期'}</dt><dd>${escape(date(order.grantEnd||order.estimatedEnd))}</dd>${order.refundedAmount?'<dt>已退金额</dt><dd>'+money(order.refundedAmount)+'</dd>':''}</dl>`;
 const showQR=order.codeUrl&&!order.purchaseUnavailable&&order.state!=='paid'&&order.state!=='closed';$('payment-qr').hidden=!showQR;
 if(showQR){const qr=qrcode(0,'M');qr.addData(order.codeUrl);qr.make();$('payment-qr').innerHTML=qr.createSvgTag({cellSize:6,margin:20,scalable:true});}
 else $('payment-qr').replaceChildren();
 const history=$('payment-refunds');history.hidden=!order.refunds?.length;
 history.innerHTML=order.refunds?.length?'<h3>退款记录</h3>'+order.refunds.map(r=>'<p>'+escape(refundLabel(r.state))+' · '+money(r.amount)+'<br><small>'+escape(date(r.updated_at))+' · '+escape(r.id)+'</small></p>').join(''):'';
 $('payment-instructions').textContent=showQR?'请使用另一台设备的微信“扫一扫”付款；Native 二维码不支持相册或长按识别。其他未支付订单不占用排期，最终生效时间以到账确认后的订单记录为准。':order.state==='paid'?'已收到后台确认，请以此处订单状态和会员生效时间为准。':'二维码暂不可用，请向平台查单确认。';
 message(state(order));
}
async function refreshCheckout(check=false){
 if(busy)return;busy=true;$('payment-check').disabled=true;
 try{const data=await api('/api/payments/orders/'+currentOrder.id+(check?'/check':''),check?{}:undefined);renderCheckout(data.order);}
 catch(e){if(e.status===401)loginNeeded();else message(e.message);}finally{busy=false;$('payment-check').disabled=false;}
}
if(view==='plans')for(const link of document.querySelectorAll('.plan-contact'))link.addEventListener('click',()=>{
 const selection=$('wecom-selection');selection.textContent='已选择'+link.closest('.recharge-plan').querySelector('h2').textContent+'。添加企业微信后，请告知客服所选套餐及本站账号。';selection.hidden=false;
 $('wecom-contact').focus({preventScroll:true});
});
async function init(){
 try{
  const [account,config]=await Promise.all([api('/api/account'),api('/api/payments/config')]);user=account.user;enabled=config.enabled;
  if(view==='plans'){
   message(!enabled?'购买会员请添加企业微信。确认套餐与付款后，由客服协助开通。':user?'已登录。选择套餐后会生成订单，请核对金额和生效时间后扫码付款。':'请先登录，再选择套餐。');$('payment-login').hidden=!!user;
   for(const link of document.querySelectorAll('.plan-contact'))link.hidden=enabled;
   $('online-payment-rules').hidden=!enabled;
   for(const button of document.querySelectorAll('[data-buy]')){button.hidden=!enabled;button.disabled=!enabled;button.onclick=async()=>{
    if(!user){location.assign('/profile?login=1&next=membership');return;}if(busy)return;busy=true;button.disabled=true;
    const planId=button.dataset.buy,key='payment-request:'+user.id+':'+planId;let requestId;
    try{requestId=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,requestId);}catch{requestId=crypto.randomUUID();}
    try{message('正在创建订单，请稍候…');const {order}=await api('/api/payments/orders',{planId,requestId});try{sessionStorage.removeItem(key);}catch{}location.assign('/membership/pay?order='+order.id);}
    catch(e){if(e.status===401)loginNeeded();else message(e.message);}finally{busy=false;button.disabled=!enabled;}
   };}
  }else if(!user){loginNeeded();}
  else if(view==='orders'){$('orders-more').onclick=loadOrders;await loadOrders();}
  else{
   const id=new URLSearchParams(location.search).get('order');if(!/^[a-f0-9]{32}$/.test(id||''))throw new Error('订单链接不完整，请从“我的订单”进入。');
   currentOrder={id};$('payment-check').onclick=()=>refreshCheckout(true);await refreshCheckout();
   poll=setInterval(()=>{if(!document.hidden&&currentOrder?.state!=='paid'&&currentOrder?.state!=='closed')refreshCheckout();},5000);
   document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshCheckout();});
  }
 }catch(e){if(e.status===401)loginNeeded();else message(e.message);}
}
window.addEventListener('pagehide',()=>clearInterval(poll));init();

export const DAY=86400000,MAX_MEMBERSHIP_END=Date.parse('2100-01-01T00:00:00.000Z');
export const PAYMENT_PLANS=Object.freeze({
 regular30:Object.freeze({id:'regular30',label:'普通会员',tier:'regular',amount:1500,currency:'CNY',days:30,durationMs:30*DAY}),
 premium30:Object.freeze({id:'premium30',label:'金会员',tier:'premium',amount:5000,currency:'CNY',days:30,durationMs:30*DAY})
});
export const retainedDuration=order=>Math.floor(order.duration_ms*Math.max(0,order.amount-order.refunded_amount)/order.amount);
// Consumed time is never taken from another order. Unused queued orders move
// forward after a refund, retaining their own paid duration and original floor.
export function scheduleGrants(orders,now){
 let cursor=now;
 return orders.sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id)).map(order=>{
  let start=order.grant_start,end=order.grant_end;
  if(start===null||start===undefined||start>now){start=Math.max(cursor,order.floor_start||now);end=start+retainedDuration(order);}
  else if(end>now){end=start+Math.max(now-start,retainedDuration(order));}
  if(end>MAX_MEMBERSHIP_END)throw new Error('会员有效期已较长，无需继续购买。');
  if(end>start)cursor=Math.max(cursor,end);return {...order,grant_start:start,grant_end:end};
 });
}
export function combinedMembership(base,orders,now=Date.now()){
 const intervals=orders.filter(o=>o.state==='paid'&&o.review_reason===null&&o.grant_end>o.grant_start).map(o=>({tier:o.tier,start:o.grant_start,end:o.grant_end}));
 if(base&&['regular','premium'].includes(base.tier)&&base.expires_at)intervals.push({tier:base.tier,start:0,end:base.expires_at});
 const active=intervals.filter(i=>i.start<=now&&i.end>now),tier=active.some(i=>i.tier==='premium')?'premium':active.length?'regular':'none';
 if(tier!=='none'){
  let end=Math.max(...active.filter(i=>i.tier===tier).map(i=>i.end)),previous;
  do{previous=end;for(const i of intervals)if(i.tier===tier&&i.start<=end&&i.end>end)end=i.end;}while(end!==previous);
  return {tier,active:true,expiresAt:end,expired:false};
 }
 const past=intervals.filter(i=>i.end<=now).map(i=>i.end),expiresAt=past.length?Math.max(...past):base?.expires_at??null;
 return {tier:'none',active:false,expiresAt,expired:past.length>0||!!base&&base.tier!=='none'&&base.expires_at<=now};
}

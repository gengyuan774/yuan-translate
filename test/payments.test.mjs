import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {paymentFixture} from './payment-fixture.mjs';
import {applyPaymentFacts,paymentOrder} from '../src/payment-ledger.js';
import {requestRefund,reconcilePayment,reconcileRefund} from '../src/payments.js';
import {membershipFor} from '../src/member.js';
import {DAY,MAX_MEMBERSHIP_END,combinedMembership,scheduleGrants} from '../src/payment-rules.js';
import {paymentReady} from '../src/wechat-pay.js';
import {profileLoginDestination} from '../src/profile-routes.js';
import {resumeDeletion} from '../src/account-data.js';
import {hashPassword} from '../src/password-server.js';
const row=(f,id)=>f.sql.prepare('SELECT * FROM payment_orders WHERE id=?').get(id);
const confirm=async(f,order)=>{const fact=f.paid(order.id);assert.equal((await f.notification(fact)).status,204);return row(f,order.id);};
test('payments fail closed without merchant setup and never expose credentials',async()=>{
 const f=await paymentFixture();delete f.env.WECHATPAY_PRIVATE_KEY;
 assert.equal(paymentReady(f.env),false);
 const config=await (await f.api('/api/payments/config')).json();
 assert.equal(config.enabled,false);assert.equal(config.automaticRenewal,false);assert.equal(config.periodDays,30);
 assert.deepEqual(config.plans.map(p=>[p.id,p.amount,p.currency]),[['regular30',1500,'CNY'],['premium30',5000,'CNY']]);
 assert.equal((await f.api('/api/payments/orders',{planId:'regular30',requestId:crypto.randomUUID()})).status,503);
 assert.equal((await f.api('/api/payments/orders',undefined,'')).status,401);
 assert.equal((await f.api('/api/admin/payments')).status,401);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_orders').get().n,0);
 assert.doesNotMatch(JSON.stringify(config),/PRIVATE KEY|test-only-key|sk-test|TOKEN/);
});
test('authoritative server price, owned orders, and same-origin mutation enforcement',async()=>{
 const f=await paymentFixture();
 for(const extra of [{amount:1},{currency:'USD'},{tier:'premium'},{accountId:f.other.id}]){
  assert.equal((await f.api('/api/payments/orders',{planId:'regular30',requestId:crypto.randomUUID(),...extra})).status,400);
 }
 const order=await f.create();
 assert.equal(order.amount,1500);assert.equal(order.currency,'CNY');assert.equal(order.state,'pending');
 assert.equal((await f.api('/api/payments/orders/'+order.id,undefined,f.otherCookie)).status,404);
 assert.equal((await f.api('/api/payments/orders/'+order.id+'/check',{},f.otherCookie)).status,404);
 assert.equal((await f.api('/api/payments/orders',{planId:'premium30',requestId:crypto.randomUUID()},f.cookie,{Origin:'https://hostile.test'})).status,403);
 assert.equal((await f.api('/api/payments/orders/'+order.id+'?success=true&paid=1')).status,200);
 assert.equal((await membershipFor(f.env,f.account.id)).active,false);
});
test('uncertain native creation and retries preserve one durable order and request identity',async()=>{
 const f=await paymentFixture(),requestId=crypto.randomUUID();f.fail();
 const one=await f.create('regular30',requestId);assert.equal(one.state,'created');assert.equal(one.codeUrl,null);
 const two=await f.create('regular30',requestId);assert.equal(one.id,two.id);assert.ok(two.codeUrl.startsWith('weixin://'));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_orders').get().n,1);
 assert.equal((await f.api('/api/payments/orders',{planId:'premium30',requestId})).status,409);
 f.fail('unsigned');const unsigned=await f.create('premium30');assert.equal(unsigned.codeUrl,null);assert.equal(unsigned.state,'created');
 assert.equal(f.calls.filter(c=>c.path.endsWith('/native'))[0].body.notify_url,'https://example.test/api/payments/wechat/notify');
});
test('valid signed encrypted callback grants without a browser; duplicate deliveries never extend rights',async()=>{
 const f=await paymentFixture(),order=await f.create(),base=f.sql.prepare('SELECT * FROM account_memberships WHERE account_id=?').get(f.account.id);
 const fact=f.paid(order.id),eventId=crypto.randomUUID();assert.equal((await f.notification(fact,{eventId})).status,204);
 const first=row(f,order.id);assert.equal(first.grant_end-first.grant_start,30*DAY);
 assert.deepEqual(f.sql.prepare('SELECT * FROM account_memberships WHERE account_id=?').get(f.account.id),base);
 assert.equal((await f.notification(fact,{eventId})).status,204);
 assert.equal((await f.notification(fact)).status,204);
 assert.equal(row(f,order.id).grant_end,first.grant_end);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM security_audit WHERE action='payment_confirmed'").get().n,1);
 const user=(await (await f.api('/api/account')).json()).user;
 assert.equal(user.membership.tier,'regular');assert.equal(user.membership.expiresAt,first.grant_end);
});
test('forged, stale, unknown-key, modified-body or broken-cipher notifications cannot grant',async()=>{
 const f=await paymentFixture(),order=await f.create(),fact=f.paid(order.id);
 for(const options of [
  {headers:{'Wechatpay-Signature':'forged'}},
  {headers:{'Wechatpay-Serial':'PUB_KEY_ID_999999'}},
  {headers:{'Wechatpay-Timestamp':'1234567890'}},
  {bodyChange:' '},
  {resourceChange:{ciphertext:'AAAA'}}
 ]){const r=await f.notification(fact,options);assert.ok([400,401].includes(r.status),await r.text());assert.equal(row(f,order.id).state,'pending');}
 const spoofed=await f.api('/api/payments/wechat/notify',{id:'fake',resource:{}},'',{'X-Account-ID':f.account.id});
 assert.equal(spoofed.status,401);
});
test('genuine signatures do not authorize wrong order, merchant, app, total, currency, transaction or status',async()=>{
 const f=await paymentFixture(),order=await f.create(),fact=f.paid(order.id);
 for(const override of [{mchid:'9999999999'},{appid:'wxffffffffffffffff'},{amount:{total:1,currency:'CNY'}},{amount:{total:1500,currency:'USD'}},{transaction_id:''},{trade_type:'JSAPI'},{trade_state:'NOTPAY'}]){
  assert.equal((await f.notification({...fact,...override})).status,409);
  assert.equal(row(f,order.id).state,'pending');
 }
 assert.equal((await f.notification(fact)).status,204);
 assert.equal((await f.notification({...fact,transaction_id:'other_transaction'})).status,409);
});
test('reused callback ID or transaction across different orders rolls back the second grant',async()=>{
 const f=await paymentFixture(),a=await f.create(),b=await f.create('premium30'),aFact=f.paid(a.id),bFact=f.paid(b.id),eventId=crypto.randomUUID();
 assert.equal((await f.notification(aFact,{eventId})).status,204);
 assert.equal((await f.notification(bFact,{eventId})).status,409);
 assert.equal(row(f,b.id).state,'pending');
 const duplicateTxn={...bFact,transaction_id:aFact.transaction_id};
 assert.equal((await f.notification(duplicateTxn)).status,503);
 assert.equal(row(f,b.id).state,'pending');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_events').get().n,1);
});
test('missed callback is repaired only by a signed provider query; disabling checkout still accepts settled payments',async()=>{
 const f=await paymentFixture(),order=await f.create();f.paid(order.id);
 f.env.WECHATPAY_ENABLED='false';
 assert.equal((await f.admin('/'+order.id+'/reconcile',{reason:'isolated missed callback test'})).status,200);
 assert.equal((await membershipFor(f.env,f.account.id)).active,true);
 const secondF=await paymentFixture(),second=await secondF.create();secondF.env.WECHATPAY_ENABLED='false';
 assert.equal((await secondF.notification(secondF.paid(second.id))).status,204);
 assert.equal((await secondF.api('/api/payments/orders',{planId:'regular30',requestId:crypto.randomUUID()})).status,503);
 assert.equal((await f.admin('/'+order.id+'/reconcile',{})).status,400);
});
test('same and different tier renewals queue exactly 30 days and preserve legacy grants',async t=>{
 let now=Date.parse('2026-10-22T12:00:00Z');t.mock.method(Date,'now',()=>now);
 const f=await paymentFixture(),legacyEnd=now+7*DAY;
 f.sql.prepare("UPDATE account_memberships SET tier='regular',expires_at=? WHERE account_id=?").run(legacyEnd,f.account.id);
 const a=await confirm(f,await f.create()),b=await confirm(f,await f.create()),c=await confirm(f,await f.create('premium30'));
 assert.equal(a.grant_start,legacyEnd);assert.equal(a.grant_end,legacyEnd+30*DAY);
 assert.equal(b.grant_start,a.grant_end);assert.equal(c.grant_start,b.grant_end);assert.equal(c.grant_end,c.grant_start+30*DAY);
 assert.equal((await membershipFor(f.env,f.account.id)).tier,'regular');assert.equal((await membershipFor(f.env,f.account.id)).expiresAt,b.grant_end);
 now=c.grant_start+1;assert.equal((await membershipFor(f.env,f.account.id)).tier,'premium');
 now=c.grant_end;assert.equal((await membershipFor(f.env,f.account.id)).active,false);
});
test('processing refund retains rights; success adjusts only that order and shifts later periods, exactly once',async t=>{
 let now=Date.parse('2026-10-22T12:00:00Z');t.mock.method(Date,'now',()=>now);
 const f=await paymentFixture(),a=await confirm(f,await f.create()),b=await confirm(f,await f.create('premium30'));
 now+=10*DAY;const fact=f.refundFact(a,{amount:750,state:'PROCESSING',id:'partial_refund'});
 await applyPaymentFacts(f.env,a.id,f.payments.get(a.id),{refund:fact});
 assert.equal(row(f,a.id).grant_end,a.grant_end);
 fact.refund_status='SUCCESS';f.payments.get(a.id).trade_state='REFUND';
 const eventId=crypto.randomUUID();assert.equal((await f.notification(fact,{kind:'REFUND.SUCCESS',eventId})).status,204);
 const after=row(f,a.id),later=row(f,b.id);assert.equal(after.refunded_amount,750);assert.equal(after.grant_end,a.grant_start+15*DAY);
 assert.equal(later.grant_start,after.grant_end);assert.equal(later.grant_end-later.grant_start,30*DAY);
 await f.notification(fact,{kind:'REFUND.SUCCESS',eventId});await f.notification(fact,{kind:'REFUND.SUCCESS'});
 assert.equal(row(f,b.id).grant_end,later.grant_end);
 await applyPaymentFacts(f.env,a.id,f.payments.get(a.id),{refund:{...fact,refund_status:'CLOSED'}});
 assert.equal(row(f,a.id).refunded_amount,750);
});
test('full refund cannot take already used time or legacy membership; closed refunds cannot regress',async t=>{
 let now=Date.parse('2026-10-22T12:00:00Z');t.mock.method(Date,'now',()=>now);
 const f=await paymentFixture(),a=await confirm(f,await f.create());now+=20*DAY;
 await applyPaymentFacts(f.env,a.id,f.payments.get(a.id),{refund:f.refundFact(a)});
 assert.equal(row(f,a.id).grant_end,now);assert.equal((await membershipFor(f.env,f.account.id)).active,false);
 const g=await paymentFixture(),legacyEnd=now+7*DAY;g.sql.prepare("UPDATE account_memberships SET tier='regular',expires_at=? WHERE account_id=?").run(legacyEnd,g.account.id);
 const future=await confirm(g,await g.create('premium30'));
 await applyPaymentFacts(g.env,future.id,g.payments.get(future.id),{refund:g.refundFact(future)});
 assert.equal((await membershipFor(g.env,g.account.id)).expiresAt,legacyEnd);
 const closed=g.refundFact(future,{id:'closed_refund',amount:1,state:'CLOSED'});
 await applyPaymentFacts(g.env,future.id,g.payments.get(future.id),{refund:closed});
 await applyPaymentFacts(g.env,future.id,g.payments.get(future.id),{refund:{...closed,refund_status:'PROCESSING'}});
 assert.equal(g.sql.prepare('SELECT state FROM payment_refunds WHERE id=?').get(closed.out_refund_no).state,'closed');
});
test('refund arriving before payment notification does not temporarily grant full rights',async()=>{
 const f=await paymentFixture(),order=await f.create();f.paid(order.id,{trade_state:'REFUND'});
 const fact=f.refundFact(order);
 assert.equal((await f.notification(fact,{kind:'REFUND.SUCCESS'})).status,204);
 assert.equal(row(f,order.id).refunded_amount,1500);assert.equal((await membershipFor(f.env,f.account.id)).active,false);
 assert.equal((await f.notification({...f.payments.get(order.id),trade_state:'SUCCESS'})).status,204);
 assert.equal((await membershipFor(f.env,f.account.id)).active,false);
});
test('unknown REFUND query holds rights pending refund facts; malformed refund cannot release the hold',async()=>{
 const f=await paymentFixture(),order=await f.create();f.paid(order.id,{trade_state:'REFUND'});
 await reconcilePayment(f.env,row(f,order.id),f.upstream);
 assert.equal(row(f,order.id).review_reason,'refund_status_review');assert.equal((await membershipFor(f.env,f.account.id)).active,false);
 const good=f.refundFact(order,{amount:750});
 await assert.rejects(applyPaymentFacts(f.env,order.id,f.payments.get(order.id),{refund:{...good,transaction_id:'foreign'}}),/不匹配/);
 await applyPaymentFacts(f.env,order.id,f.payments.get(order.id),{refund:good});
 assert.equal(row(f,order.id).review_reason,null);assert.equal(row(f,order.id).grant_end-row(f,order.id).grant_start,15*DAY);
});
test('admin-only refund reservations prevent over-refund and retries use the original provider refund ID',async()=>{
 const f=await paymentFixture(),order=await confirm(f,await f.create()),requestId=crypto.randomUUID(),data={orderId:order.id,amount:1000,requestId,reason:'隔离测试退款'};
 assert.equal((await f.api('/api/admin/payments/refund',data)).status,401);
 let response=await f.admin('/refund',data);assert.equal(response.status,200,await response.clone().text());
 const first=(await response.json()).refund;assert.equal(first.state,'processing');assert.equal(row(f,order.id).refunded_amount,0);
 const beforeCalls=f.calls.length;response=await f.admin('/refund',data);assert.equal((await response.json()).refund.id,first.id);
 assert.equal(f.calls.slice(beforeCalls).some(c=>c.path==='/v3/refund/domestic/refunds'),false);
 assert.equal((await f.admin('/refund',{...data,amount:1001})).status,409);
 assert.equal((await f.admin('/refund',{...data,amount:501,requestId:crypto.randomUUID()})).status,409);
 f.refunds.get(first.id).status='SUCCESS';f.payments.get(order.id).trade_state='REFUND';
 await reconcileRefund(f.env,row(f,order.id),first.id,f.upstream);
 assert.equal(row(f,order.id).refunded_amount,1000);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM security_audit WHERE action='payment_refund_requested'").get().n,1);
});
test('uncertain refund request retains reservation and retry never makes a new refund ID',async()=>{
 const f=await paymentFixture(),order=await confirm(f,await f.create()),data={orderId:order.id,amount:1500,requestId:crypto.randomUUID(),reason:'test retry'};
 let failed=false;const upstream=async(url,options)=>{if(!failed&&new URL(url).pathname==='/v3/refund/domestic/refunds'){failed=true;throw new Error('timeout');}return f.upstream(url,options);};
 await assert.rejects(requestRefund(f.env,data,upstream),/查单/);
 const reserved=f.sql.prepare('SELECT * FROM payment_refunds WHERE order_id=?').get(order.id);assert.equal(reserved.state,'created');
 await requestRefund(f.env,data,f.upstream);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_refunds WHERE order_id=?').get(order.id).n,1);
 assert.equal(f.calls.find(c=>c.path==='/v3/refund/domestic/refunds').body.out_refund_no,reserved.id);
});
test('atomic ledger and refund-request audit failures roll back events, rights and reservation',async()=>{
 const f=await paymentFixture(),order=await f.create(),fact=f.paid(order.id);
 f.sql.exec("CREATE TRIGGER fail_payment_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 assert.equal((await f.notification(fact)).status,503);
 assert.equal(row(f,order.id).state,'pending');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_events').get().n,0);
 f.sql.exec('DROP TRIGGER fail_payment_audit');await f.notification(fact);
 f.sql.exec("CREATE TRIGGER fail_refund_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 await assert.rejects(requestRefund(f.env,{orderId:order.id,amount:100,requestId:crypto.randomUUID(),reason:'atomic test'},f.upstream));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_refunds').get().n,0);
});
test('deleted/deleting owners retain an unlinked financial fact but receive no membership',async()=>{
 for(const action of ['deleting','deleted']){
  const f=await paymentFixture(),order=await f.create(),fact=f.paid(order.id);
  if(action==='deleting')f.sql.prepare("UPDATE account_security SET status='deleting' WHERE account_id=?").run(f.account.id);
  else {
   f.env.BUCKET={async list(){return {objects:[]};},async delete(){}};
   const job=crypto.randomUUID();
   f.sql.prepare("UPDATE account_security SET status='deleting' WHERE account_id=?").run(f.account.id);
   f.sql.prepare("INSERT INTO deletion_jobs (id,account_id,token_hash,status,created_at) VALUES (?,?,?,'pending',?)").run(job,f.account.id,'unused',Date.now()-100000);
   assert.equal((await resumeDeletion(new Request('https://example.test'),f.env,{jobId:job},true)).status,'completed');
  }
  assert.equal((await f.notification(fact)).status,204);
  assert.equal(row(f,order.id).state,'paid');assert.equal(row(f,order.id).review_reason,'account_closed');assert.equal(row(f,order.id).grant_start,null);
  if(action==='deleted')assert.equal(row(f,order.id).account_id,null);
 }
});
test('expired unpaid orders close only after provider confirmation; fake success URLs never confirm',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const f=await paymentFixture(),order=await f.create();now+=31*60000;
 const closed=await reconcilePayment(f.env,row(f,order.id),f.upstream);
 assert.equal(closed.state,'closed');assert.equal((await membershipFor(f.env,f.account.id)).active,false);
 assert.ok(f.calls.some(c=>c.path.endsWith('/close')));
 const browser=readFileSync(new URL('../src/membership.js',import.meta.url),'utf8');
 assert.doesNotMatch(browser,/searchParams\.get\(['"](?:paid|success|status)['"]\)/);
 assert.equal(profileLoginDestination('?next=membership'),'membership');assert.equal(profileLoginDestination('?next=orders'),'orders');
 assert.notEqual(profileLoginDestination('https://evil.test'),'https://evil.test');
});
test('membership cap, immutable 30-day duration and current tier selection handle boundary cases',()=>{
 const now=Date.now(),order={id:'a',state:'paid',review_reason:null,sequence:1,tier:'premium',amount:5000,refunded_amount:0,duration_ms:30*DAY,grant_start:null,grant_end:null,floor_start:MAX_MEMBERSHIP_END-DAY};
 assert.throws(()=>scheduleGrants([order],now));
 assert.equal(combinedMembership(null,[{...order,grant_start:now+DAY,grant_end:now+31*DAY}],now).active,false);
 assert.equal(combinedMembership({tier:'regular',expires_at:now+DAY},[{...order,grant_start:now,grant_end:now+2*DAY}],now).tier,'premium');
});
test('concurrent payments and duplicated callbacks serialize through the account version',async()=>{
 const f=await paymentFixture(),a=await f.create(),b=await f.create('premium30'),aFact=f.paid(a.id),bFact=f.paid(b.id);
 const results=await Promise.all([applyPaymentFacts(f.env,a.id,aFact),applyPaymentFacts(f.env,b.id,bFact)]);
 const sorted=results.sort((a,b)=>a.sequence-b.sequence);
 assert.equal(sorted[1].grant_start,sorted[0].grant_end);
 assert.equal(sorted[1].grant_end-sorted[1].grant_start,30*DAY);
 const event={id:crypto.randomUUID(),kind:'TRANSACTION.SUCCESS'};
 const duplicates=await Promise.allSettled([applyPaymentFacts(f.env,a.id,aFact,{event}),applyPaymentFacts(f.env,a.id,aFact,{event})]);
 assert.ok(duplicates.some(r=>r.status==='fulfilled'));
 for(const result of duplicates)if(result.status==='rejected')assert.match(result.reason.message,/UNIQUE constraint/);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payment_events WHERE id=?').get(event.id).n,1);
 assert.equal(row(f,a.id).grant_end,results.find(r=>r.id===a.id).grant_end);
});
test('older authenticated accounts initialize the security row and the new checkout routes serve separately',async()=>{
 const f=await paymentFixture(),order=await f.create();
 f.sql.prepare('DELETE FROM account_security WHERE account_id=?').run(f.account.id);
 assert.equal((await f.notification(f.paid(order.id))).status,204);
 assert.equal((await membershipFor(f.env,f.account.id)).active,true);
 for(const [path,view] of [['/membership','plans'],['/membership/orders','orders'],['/membership/pay','checkout']]){
  const response=await f.api(path);assert.equal(response.status,200);assert.match(await response.text(),new RegExp('data-payment-view="'+view+'"'));
 }
});
test('personal data export contains only the owner payment ledger and no payment credentials',async()=>{
 const f=await paymentFixture(),order=await confirm(f,await f.create()),foreign=await f.create('premium30',crypto.randomUUID(),f.otherCookie);
 const password='test-password-export';f.env.BUCKET={async get(){return null;}};
 f.sql.prepare('INSERT INTO account_passwords (username,account_id,password_hash,created_at) VALUES (?,?,?,?)').run('payment-qa',f.account.id,await hashPassword(password),Date.now());
 const response=await f.api('/api/account/data/export',{currentPassword:password});assert.equal(response.status,200);
 const text=await response.text();assert.match(text,/"type":"payment_order"/);assert.ok(text.includes(order.id));assert.ok(!text.includes(foreign.id));
 assert.doesNotMatch(text,/PRIVATE KEY|BEGIN PUBLIC KEY|token_hash|mutation_token|password_hash|WECHATPAY_|sk-test/);
 assert.match(text,/"type":"complete"/);
});
test('concurrent successful refunds cannot exceed order gross or overwrite another order rights',async()=>{
 const f=await paymentFixture(),a=await confirm(f,await f.create()),b=await confirm(f,await f.create('premium30'));
 const results=await Promise.allSettled([
  applyPaymentFacts(f.env,a.id,f.payments.get(a.id),{refund:f.refundFact(a,{id:'concurrent_one',amount:1000})}),
  applyPaymentFacts(f.env,a.id,f.payments.get(a.id),{refund:f.refundFact(a,{id:'concurrent_two',amount:1000})})
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(row(f,a.id).refunded_amount,1000);
 assert.equal(row(f,b.id).grant_end-row(f,b.id).grant_start,30*DAY);
});

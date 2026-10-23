import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
import {digest} from '../src/security-common.js';
const enc=new TextEncoder();
const b64=bytes=>Buffer.from(bytes).toString('base64');
const pem=(kind,bytes)=>'-----BEGIN '+kind+'-----\n'+b64(bytes)+'\n-----END '+kind+'-----';
const keyOptions={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const merchant=await crypto.subtle.generateKey(keyOptions,true,['sign','verify']);
const platform=await crypto.subtle.generateKey(keyOptions,true,['sign','verify']);
const merchantPem=pem('PRIVATE KEY',await crypto.subtle.exportKey('pkcs8',merchant.privateKey));
const platformPem=pem('PUBLIC KEY',await crypto.subtle.exportKey('spki',platform.publicKey));
export const adminToken='cd'.repeat(32);
export async function paymentFixture(){
 const f=environment(),{env,sql}=f;
 const originalBatch=env.DB.batch.bind(env.DB);let previousBatch=Promise.resolve();
 env.DB.batch=items=>{const result=previousBatch.then(()=>originalBatch(items));previousBatch=result.catch(()=>{});return result;};
 Object.assign(env,{WECHATPAY_ENABLED:'true',PAYMENTS_PUBLIC_ORIGIN:'https://example.test',WECHATPAY_MCH_ID:'1234567890',WECHATPAY_APP_ID:'wx0123456789abcdef',WECHATPAY_CERT_SERIAL:'AB'.repeat(16),WECHATPAY_PRIVATE_KEY:merchantPem,WECHATPAY_API_V3_KEY:'1'.repeat(32),WECHATPAY_PUBLIC_KEY_ID:'PUB_KEY_ID_123456',WECHATPAY_VERIFY_KEYS:JSON.stringify({PUB_KEY_ID_123456:platformPem}),MEMBER_ADMIN_TOKEN_SHA256:await digest(adminToken)});
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:crypto.randomUUID()+'@example.test',label:'payment-qa'});
 const other=await createVerifiedAccountSession(env,{provider:'email',subject:crypto.randomUUID()+'@example.test',label:'other-qa'});
 const cookie=account.cookie.split(';')[0],otherCookie=other.cookie.split(';')[0];
 const payments=new Map(),refunds=new Map(),calls=[];
 let failNext=null,refundState='PROCESSING';
 async function signed(raw,{status=200,timestamp=String(Math.floor(Date.now()/1000)),serial=env.WECHATPAY_PUBLIC_KEY_ID,nonce='synthetic-test-response'}={}){
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',platform.privateKey,enc.encode(timestamp+'\n'+nonce+'\n'+raw+'\n'));
  return new Response(status===204?null:raw,{status,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,'Wechatpay-Serial':serial,'Wechatpay-Nonce':nonce,'Wechatpay-Signature':b64(signature)}});
 }
 async function upstream(url,options={}){
  assert.equal(new URL(url).origin,'https://api.mch.weixin.qq.com');
  const path=new URL(url).pathname,raw=options.body||'',body=raw?JSON.parse(raw):null;
  const fields=Object.fromEntries(Array.from(options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g),m=>[m[1],m[2]]));
  assert.equal(fields.mchid,env.WECHATPAY_MCH_ID);
  assert.equal(fields.serial_no,env.WECHATPAY_CERT_SERIAL);
  assert.equal(options.redirect,'error');
  const canonical=[options.method,new URL(url).pathname+new URL(url).search,fields.timestamp,fields.nonce_str,raw,''].join('\n');
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',merchant.publicKey,Buffer.from(fields.signature,'base64'),enc.encode(canonical)),true);
  calls.push({path,method:options.method,body});
  if(failNext){const failure=failNext;failNext=null;if(failure==='unsigned')return Response.json({code_url:'weixin://wxpay/bizpayurl?fake=1'});throw new Error('synthetic network failure');}
  if(path==='/v3/pay/transactions/native'){
   if(!payments.has(body.out_trade_no))payments.set(body.out_trade_no,{out_trade_no:body.out_trade_no,mchid:body.mchid,appid:body.appid,trade_type:'NATIVE',trade_state:'NOTPAY',amount:body.amount});
   return signed(JSON.stringify({code_url:'weixin://wxpay/bizpayurl?pr='+body.out_trade_no}));
  }
  const close=path.match(/^\/v3\/pay\/transactions\/out-trade-no\/([a-f0-9]{32})\/close$/);
  if(close){const p=payments.get(close[1]);if(p.trade_state==='NOTPAY')p.trade_state='CLOSED';return signed('',{status:204});}
  const query=path.match(/^\/v3\/pay\/transactions\/out-trade-no\/([a-f0-9]{32})$/);
  if(query)return signed(JSON.stringify(payments.get(query[1])));
  if(path==='/v3/refund/domestic/refunds'&&options.method==='POST'){
   const p=Array.from(payments.values()).find(p=>p.transaction_id===body.transaction_id);
   if(!refunds.has(body.out_refund_no))refunds.set(body.out_refund_no,{out_refund_no:body.out_refund_no,out_trade_no:p.out_trade_no,transaction_id:p.transaction_id,refund_id:'provider_'+body.out_refund_no,status:refundState,amount:body.amount});
   if(refundState==='SUCCESS')p.trade_state='REFUND';
   return signed(JSON.stringify(refunds.get(body.out_refund_no)));
  }
  const refundQuery=path.match(/^\/v3\/refund\/domestic\/refunds\/([^/]+)$/);
  if(refundQuery)return signed(JSON.stringify(refunds.get(decodeURIComponent(refundQuery[1]))));
  throw new Error('Unexpected fake provider path: '+path);
 }
 const api=(path,body,who=cookie,headers={})=>handle(req(path,body,who,headers),upstream,env);
 const admin=(path,body)=>api('/api/admin/payments'+path,body,'',{Authorization:'Bearer '+adminToken});
 async function create(planId='regular30',requestId=crypto.randomUUID(),who=cookie){
  const r=await api('/api/payments/orders',{planId,requestId},who);
  assert.equal(r.status,200,await r.clone().text());return (await r.json()).order;
 }
 function paid(id,overrides={}){
  const previous=payments.get(id),p={...previous,trade_state:'SUCCESS',transaction_id:'txn_'+id,success_time:new Date().toISOString(),...overrides};payments.set(id,p);return p;
 }
 async function notification(fact,{kind='TRANSACTION.SUCCESS',eventId=crypto.randomUUID(),headers:changes={},bodyChange='',resourceChange}={}){
  const aes=await crypto.subtle.importKey('raw',enc.encode(env.WECHATPAY_API_V3_KEY),'AES-GCM',false,['encrypt']);
  const nonce='testnonce123',associated_data='transaction';
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:enc.encode(nonce),additionalData:enc.encode(associated_data),tagLength:128},aes,enc.encode(JSON.stringify(fact)));
  const raw=JSON.stringify({id:eventId,event_type:kind,resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data,ciphertext:b64(cipher),...resourceChange}});
  const response=await signed(raw),headers=new Headers(response.headers);
  for(const [key,value] of Object.entries(changes))headers.set(key,value);
  headers.set('Sec-Fetch-Site','cross-site');
  return handle(new Request('https://example.test/api/payments/wechat/notify',{method:'POST',headers,body:raw+bodyChange}),upstream,env);
 }
 const refundFact=(order,{id='external_'+crypto.randomUUID(),amount=order.amount,state='SUCCESS'}={})=>({mchid:env.WECHATPAY_MCH_ID,out_trade_no:order.id,transaction_id:'txn_'+order.id,out_refund_no:id,refund_id:'provider_'+id,refund_status:state,amount:{refund:amount,total:order.amount,currency:order.currency}});
 return {...f,account:account.user,other:other.user,cookie,otherCookie,api,admin,create,paid,notification,refundFact,payments,refunds,calls,upstream,signed,fail(value='network'){failNext=value;},setRefundState(value){refundState=value;}};
}

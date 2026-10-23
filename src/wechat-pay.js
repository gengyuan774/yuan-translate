import {MemberError} from './errors.js';
const encode=new TextEncoder(),keyCache=new Map();
const bytes64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
function verifyKeys(env){try{const keys=JSON.parse(env.WECHATPAY_VERIFY_KEYS||'{}');return keys&&typeof keys==='object'&&!Array.isArray(keys)?keys:{};}catch{return {};}}
export function wechatConfigured(env){
 let origin;try{const url=new URL(env.PAYMENTS_PUBLIC_ORIGIN);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return false;origin=url.origin;}catch{return false;}
 const publicKey=verifyKeys(env)[env.WECHATPAY_PUBLIC_KEY_ID];
 return !!(env.DB&&/^\d{6,20}$/.test(env.WECHATPAY_MCH_ID||'')&&/^wx[a-f0-9]{16}$/.test(env.WECHATPAY_APP_ID||'')&&/^[A-Fa-f0-9]{16,64}$/.test(env.WECHATPAY_CERT_SERIAL||'')&&typeof env.WECHATPAY_PRIVATE_KEY==='string'&&env.WECHATPAY_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')&&encode.encode(env.WECHATPAY_API_V3_KEY||'').length===32&&/^PUB_KEY_ID_\d+$/.test(env.WECHATPAY_PUBLIC_KEY_ID||'')&&typeof publicKey==='string'&&publicKey.includes('BEGIN PUBLIC KEY')&&origin);
}
export const paymentReady=env=>env.WECHATPAY_ENABLED==='true'&&wechatConfigured(env);
export function requirePayments(env){if(!paymentReady(env))throw new MemberError('在线支付尚未开通，暂时无法创建支付订单。',503);}
async function rsaKey(pem,privateKey=false){
 const key=(privateKey?'private:':'public:')+pem;
 if(!keyCache.has(key)){
  const raw=bytes64(pem.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,''));
  const imported=crypto.subtle.importKey(privateKey?'pkcs8':'spki',raw,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,[privateKey?'sign':'verify']);
  keyCache.set(key,imported);if(keyCache.size>8)keyCache.delete(keyCache.keys().next().value);imported.catch(()=>keyCache.delete(key));
 }
 return keyCache.get(key);
}
export async function verifyWechat(headers,raw,env){
 const serial=headers.get('Wechatpay-Serial'),pem=verifyKeys(env)[serial],timestamp=headers.get('Wechatpay-Timestamp'),nonce=headers.get('Wechatpay-Nonce'),signature=headers.get('Wechatpay-Signature');
 if(!pem||!/^\d{10}$/.test(timestamp||'')||Math.abs(Date.now()/1000-Number(timestamp))>300||!nonce||nonce.length>128||/[\r\n]/.test(nonce)||!signature||signature.length>1024)throw new MemberError('支付消息验签失败',401);
 try{if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',await rsaKey(pem),bytes64(signature),encode.encode(timestamp+'\n'+nonce+'\n'+raw+'\n')))throw new Error();}catch{throw new MemberError('支付消息验签失败',401);}
}
export async function decryptWechat(resource,env){
 if(resource?.algorithm!=='AEAD_AES_256_GCM'||typeof resource.nonce!=='string'||typeof resource.ciphertext!=='string'||resource.ciphertext.length>50000)throw new MemberError('支付通知内容无效',400);
 try{const key=await crypto.subtle.importKey('raw',encode.encode(env.WECHATPAY_API_V3_KEY),{name:'AES-GCM'},false,['decrypt']);const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:encode.encode(resource.nonce),additionalData:encode.encode(resource.associated_data||''),tagLength:128},key,bytes64(resource.ciphertext));return JSON.parse(new TextDecoder().decode(decoded));}catch{throw new MemberError('支付通知解密失败',400);}
}
export async function wechatCall(env,method,path,body,upstream=fetch){
 if(!wechatConfigured(env))throw new MemberError('支付平台尚未配置',503);
 if(!path.startsWith('/v3/')||/[\r\n]/.test(path))throw new Error('Invalid payment path');
 const raw=body===undefined?'':JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomUUID().replaceAll('-','');
 let signature;try{signature=base64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',await rsaKey(env.WECHATPAY_PRIVATE_KEY,true),encode.encode([method,path,timestamp,nonce,raw,''].join('\n'))));}catch{throw new MemberError('支付服务配置无效，请联系客服。',503);}
 const authorization=`WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHATPAY_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${env.WECHATPAY_CERT_SERIAL}",signature="${signature}"`;
 let response;try{response=await upstream('https://api.mch.weixin.qq.com'+path,{method,headers:{Authorization:authorization,'Content-Type':'application/json',Accept:'application/json','Wechatpay-Serial':env.WECHATPAY_PUBLIC_KEY_ID,'User-Agent':'ManjiSufan/1.0'},body:raw||undefined,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw new MemberError('支付平台状态暂未确认，请查单后重试，不要重复付款。',503);}
 if(response.status>=300&&response.status<400)throw new MemberError('支付平台返回异常跳转，请联系客服。',503);
 const text=await response.text();await verifyWechat(response.headers,text,env);
 if(!response.ok)throw new MemberError('支付平台暂未确认操作，请稍后查单或联系客服。',503);
 try{return text?JSON.parse(text):{};}catch{throw new MemberError('支付平台响应无效',503);}
}
export const queryWechat=(env,id,upstream)=>wechatCall(env,'GET','/v3/pay/transactions/out-trade-no/'+id+'?mchid='+env.WECHATPAY_MCH_ID,undefined,upstream);

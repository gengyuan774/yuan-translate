import {validTranslationMode} from './models.js';
import {translationStream} from './translation-proxy.js';
import assets from './generated-assets.js';
import {TEXT_MODEL} from './models.js';
import {MemberError,membershipFor,memberSession,sharedReady,loginMember,allowSharedRequest,realtimeAvailability} from './member.js';
import {upstreamError} from './upstream-error.js';
import {accountUser,requireAccount,signOutAccount} from './account-server.js';
import {phoneReady,sendPhoneCode,verifyPhoneCode} from './phone-server.js';
import {passwordAccount} from './password-server.js';
import {requireMemberAdmin,adminMembership,updateAdminMembership} from './admin-membership.js';
import {accountSecurityInfo,recoveryReady,changePassword,sendRecovery,finishRecovery} from './account-security.js';
import {exportAccount,startDeletion,resumeDeletion} from './account-data.js';
import {adminSecurity,adminSecurityAction} from './admin-security.js';
import {securityRate} from './security-common.js';
import {historyRoute} from './history-server.js';
import {checkAdminHistory} from './admin-history.js';
import {transcriptionConfig,validLanguage} from './languages.js';
import {profileRoute} from './profile-routes.js';
import {paymentConfig,userPayments,paymentWebhook,adminPayments} from './payments.js';
const reply=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function readJson(request,max=350000){
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new MemberError('输入格式不正确',415);
 if(Number(request.headers.get('content-length'))>max)throw new MemberError('请求过大',413);
 const reader=request.body?.getReader();if(!reader)throw new MemberError('请求为空',400);
 const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new MemberError('请求过大',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result;}catch{throw new MemberError('输入格式不正确',400);}
}
export async function handle(request,upstream=fetch,env={}){
 const url=new URL(request.url);
 if(!url.pathname.startsWith('/api/')){
  const asset=assets[profileRoute(url.pathname)?'/':url.pathname==='/membership'?'/membership.html':url.pathname==='/membership/orders'?'/orders.html':url.pathname==='/membership/pay'?'/checkout.html':url.pathname==='/recover'?'/recover.html':url.pathname];if(!asset)return new Response('Not found',{status:404});if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
  return new Response(request.method==='HEAD'?null:asset.base64?Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)):asset.text,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'microphone=(self)', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://api.openai.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}});
 }
 const paymentNotification=url.pathname==='/api/payments/wechat/notify';
 if(!paymentNotification&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return reply({error:{message:'不允许跨站请求'}},403);
 if(!paymentNotification&&request.headers.get('Sec-Fetch-Site')==='cross-site')return reply({error:{message:'不允许跨站请求'}},403);
 try{
  if(paymentNotification)return await paymentWebhook(request,env,upstream);
  if(url.pathname==='/api/payments/config'&&request.method==='GET')return reply(paymentConfig(env));
  if(url.pathname.startsWith('/api/payments/'))return reply(await userPayments(request,env,url.pathname,request.method==='POST'?await readJson(request,4096):undefined,upstream));
  if(url.pathname==='/api/admin/membership'){
   await requireMemberAdmin(request,env);
   if(request.method==='GET')return reply(await adminMembership(env,url.searchParams.get('username')));
   if(request.method==='PUT')return reply(await updateAdminMembership(env,await readJson(request,4096)));
   return reply({error:{message:'Method not allowed'}},405,{Allow:'GET, PUT'});
  }
  if(url.pathname.startsWith('/api/admin/')){
   await requireMemberAdmin(request,env);await securityRate(request,env,'admin','',60);
   if(url.pathname==='/api/admin/payments'||url.pathname.startsWith('/api/admin/payments/'))return reply(await adminPayments(request,env,url.pathname,request.method==='POST'?await readJson(request,4096):undefined,upstream));
   if(url.pathname==='/api/admin/history/check'&&request.method==='GET')return reply(await checkAdminHistory(env,url.searchParams.get('username'),url.searchParams.get('classId')));
   if(url.pathname==='/api/admin/security'&&request.method==='GET')return reply(await adminSecurity(env,url.searchParams.get('username')));
   if(url.pathname==='/api/admin/security'&&request.method==='POST')return reply(await adminSecurityAction(env,await readJson(request,4096)));
   if(url.pathname==='/api/admin/deletions'&&request.method==='GET')return reply((await env.DB.prepare("SELECT id,account_id,status,created_at FROM deletion_jobs WHERE status='pending' ORDER BY created_at LIMIT 100").bind().all()).results);
   if(url.pathname==='/api/admin/deletion/resume'&&request.method==='POST')return reply(await resumeDeletion(request,env,await readJson(request,4096),true));
   return reply({error:{message:'Not found'}},404);
  }
  if(url.pathname==='/api/account/security'&&request.method==='GET'){const user=await requireAccount(request,env);return reply(await accountSecurityInfo(env,user));}
  if(url.pathname==='/api/account/recovery/options'&&request.method==='GET')return reply({email:recoveryReady(env)});
  if(url.pathname==='/api/account/password/change'&&request.method==='POST')return reply(await changePassword(request,env,await readJson(request,4096)));
  for(const purpose of ['bind','reset']){
   if(url.pathname==='/api/account/recovery/'+purpose+'/send'&&request.method==='POST')return reply(await sendRecovery(request,env,await readJson(request,4096),purpose,upstream));
   if(url.pathname==='/api/account/recovery/'+purpose+'/verify'&&request.method==='POST')return reply(await finishRecovery(request,env,await readJson(request,4096),purpose));
  }
  if(url.pathname==='/api/account/data/export'&&request.method==='POST')return await exportAccount(request,env,await readJson(request,4096));
  if(url.pathname==='/api/account/delete'&&request.method==='POST')return reply(await startDeletion(request,env,await readJson(request,4096)));
  if(url.pathname==='/api/account/deletion/resume'&&request.method==='POST')return reply(await resumeDeletion(request,env,await readJson(request,4096)));
  if(url.pathname==='/api/account'&&request.method==='GET'){const user=await accountUser(request,env);if(user)user.membership=await membershipFor(env,user.id);return reply({user,methods:{password:!!env.DB,phone:phoneReady(env),email:false,wechat:false}});}
  if(['/api/account/register/password','/api/account/login/password'].includes(url.pathname)&&request.method==='POST'){const result=await passwordAccount(request,env,await readJson(request,4096),url.pathname.includes('/register/'));result.user.membership=await membershipFor(env,result.user.id);return reply({user:result.user},200,{'Set-Cookie':result.cookie});}
  if(url.pathname==='/api/account/phone/send'&&request.method==='POST')return reply(await sendPhoneCode(request,env,await readJson(request,4096),upstream));
  if(url.pathname==='/api/account/login/phone'&&request.method==='POST'){const result=await verifyPhoneCode(request,env,await readJson(request,4096),upstream);result.user.membership=await membershipFor(env,result.user.id);return reply({user:result.user},200,{'Set-Cookie':result.cookie});}
  if(url.pathname==='/api/account/logout'&&request.method==='POST'){
   await readJson(request,4096);return reply({ok:true},200,{'Set-Cookie':await signOutAccount(request,env)});
  }
  if(/^\/api\/account\/login\/(phone|email|wechat)$/.test(url.pathname))return reply({error:{message:'该登录方式尚未接入，请稍后再试。'}},503);
  if(url.pathname==='/api/history'||url.pathname.startsWith('/api/history/')){
   const user=await requireAccount(request,env);
   if(request.headers.get('X-Account-ID')&&request.headers.get('X-Account-ID')!==user.id)throw new MemberError('登录账户已变化，请刷新页面后继续。',409);
   const data=request.method==='PUT'?await readJson(request,url.pathname.includes('/materials/')?1000000:8000000):undefined;
   return reply(await historyRoute(request,env,user,url.pathname,data));
  }
  if(url.pathname==='/api/member/status'&&request.method==='GET')return reply({member:!!await memberSession(request,env),sharedReady:sharedReady(env)});
  if(url.pathname==='/api/member/login'&&request.method==='POST'){
   const data=await readJson(request,4096);const membership=await loginMember(request,env,data.code);return reply({member:membership.active,membership,sharedReady:sharedReady(env)});
  }
  if(url.pathname==='/api/member/logout'&&request.method==='POST'){
   await readJson(request,4096);return reply({member:false,sharedReady:sharedReady(env)},200,{'Set-Cookie':await signOutAccount(request,env)});
  }
  if(url.pathname==='/api/openai/status'&&request.method==='GET')return reply(await realtimeAvailability(request,env));
  if(!['/api/openai/responses','/api/openai/token'].includes(url.pathname))return reply({error:{message:'Not found'}},404);
  if(request.method!=='POST')return reply({error:{message:'Method not allowed'}},405);
  if(request.headers.get('X-Access-Mode')!=='member')return reply({error:{message:'请登录并开通会员后使用。'}},401);
  const data=await readJson(request);let endpoint,payload;
  if(url.pathname.endsWith('/token')){
   const sourceLanguage=data.sourceLanguage??'en';if(!validLanguage(sourceLanguage))throw new MemberError('请选择支持的语言',400);
   const mode=data.translationMode??'accurate';if(!validTranslationMode(mode))throw new MemberError('请选择支持的翻译模式',400);
   endpoint='realtime/client_secrets';payload={expires_after:{anchor:'created_at',seconds:60},session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:transcriptionConfig(sourceLanguage,data.title,mode),turn_detection:null}}}};
  }else{
   if(typeof data.input!=='string'||typeof data.instructions!=='string')return reply({error:{message:'输入格式不正确'}},400);
   if(data.input.length+data.instructions.length>80000)return reply({error:{message:'输入内容过长，请减少参考资料后重试。'}},413);
   endpoint='responses';payload={...(data.stream===true?{stream:true}:{}),model:TEXT_MODEL,input:data.input,instructions:data.instructions,store:false,max_output_tokens:Math.max(1,Math.min(Math.floor(Number(data.max_output_tokens))||4000,4000))};
  }
  const auth='Bearer '+await allowSharedRequest(request,env,endpoint==='responses'?'text':'token',(data.input?.length||0)+(data.instructions?.length||0));
  const response=await upstream('https://api.openai.com/v1/'+endpoint,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
  if(response.ok&&payload.stream){
   if(!response.headers.get('Content-Type')?.includes('text/event-stream'))return reply({error:{message:'翻译服务未返回预期格式，请重试。'}},503);
   return new Response(translationStream(response.body),{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'}});
  }
  const result=await response.json().catch(()=>null);
  if(!response.ok)return reply({error:upstreamError(response.status,result?.error)},response.status===401||response.status===403?503:response.status);
  if(!result)throw new Error('Invalid upstream response');
  return reply(result,response.status);
 }catch(error){return reply({error:{message:error instanceof MemberError?error.message:'请求处理失败或服务暂不可用，请稍后重试。'}},error instanceof MemberError?error.status:503);}
}
export default {fetch(request,env){return handle(request,fetch,env);}};

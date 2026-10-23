import {createRegistrationChallenge} from './registration-security.js';
import {verifyTrialTranslation} from './audio-proof.js';
import {summarizeService} from './summary-service.js';
import {TRANSLATION_INSTRUCTIONS} from './translation-prompt.js';
import {trialFor} from './trial.js';
import {myUsage,publicPlans,recordingAvailability,takeOverRecording,releaseOwnedRecording} from './service-ledger.js';
import {meteredText} from './metered-text.js';
import {realtimeRelay} from './realtime-relay.js';
import {checkRealtimeConnection} from './realtime-connection.js';
import {adminCostRoutes,redeemAdminTicket} from './service-admin.js';
import assets from './generated-assets.js';
import {TEXT_MODEL} from './models.js';
import {MemberError,membershipFor,memberSession,sharedReady,loginMember,allowSharedRequest,realtimeAvailability,consume} from './member.js';
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
async function trialInfo(env,accountId){
 const trial=await trialFor(env,accountId);if(!trial)return {eligible:false,grantedMinutes:0,usedMinutes:0,remainingMinutes:0};
 const usage=await myUsage(null,env,trial);return {eligible:true,grantedMinutes:60,usedMinutes:usage.usedMinutes,remainingMinutes:usage.remainingMinutes};
}
async function enrichUser(env,user){if(user){user.membership=await membershipFor(env,user.id);user.trial=await trialInfo(env,user.id);}return user;}
export async function handle(request,upstream=fetch,env={},runtime={}){
 const url=new URL(request.url);
 if(!url.pathname.startsWith('/api/')){
  const asset=assets[profileRoute(url.pathname)?'/':url.pathname==='/usage'?'/usage.html':url.pathname==='/admin/usage'?'/admin-usage.html':url.pathname==='/membership'?'/membership.html':url.pathname==='/membership/orders'?'/orders.html':url.pathname==='/membership/pay'?'/checkout.html':url.pathname==='/recover'?'/recover.html':url.pathname];if(!asset)return new Response('Not found',{status:404});if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
  return new Response(request.method==='HEAD'?null:asset.base64?Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)):asset.text,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'microphone=(self)', 'Content-Security-Policy':`default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data:; connect-src 'self' ${url.protocol==='https:'?'wss:':'ws:'}//${url.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`}});
 }
 const paymentNotification=url.pathname==='/api/payments/wechat/notify';
 if(!paymentNotification&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return reply({error:{message:'不允许跨站请求'}},403);
 if(!paymentNotification&&request.headers.get('Sec-Fetch-Site')==='cross-site')return reply({error:{message:'不允许跨站请求'}},403);
 try{
  if(paymentNotification)return await paymentWebhook(request,env,upstream);
  if(url.pathname==='/api/openai/realtime')return await realtimeRelay(request,env,upstream,runtime);
  if(url.pathname==='/api/openai/recording/release'&&request.method==='POST'){
   const user=await requireAccount(request,env),data=await readJson(request,1024);await consume(env,'recording-release:'+user.id,30,60);
   return reply(await releaseOwnedRecording(env,user.id,data.owner));
  }
  if(url.pathname==='/api/openai/recording/takeover'&&request.method==='POST'){
   const user=await requireAccount(request,env),data=await readJson(request,1024);await consume(env,'recording-takeover:'+user.id,3,60);
   return reply(await takeOverRecording(request,env,data.leaseId));
  }
  if(url.pathname==='/api/service/plans'&&request.method==='GET')return reply(await publicPlans(env));
  if(url.pathname==='/api/account/usage'&&request.method==='GET'){await requireAccount(request,env);return reply(await myUsage(request,env));}
  if(url.pathname==='/api/service/summary'){
   if(request.method!=='POST')return reply({error:{message:'Method not allowed'}},405);
   if(request.headers.get('X-Access-Mode')!=='member')throw new MemberError('请先登录。',401);
   const data=await readJson(request,8_000_000);
   await allowSharedRequest(request,env,'text',JSON.stringify(data).length);
   return await summarizeService(request,env,data,upstream);
  }
  if(url.pathname==='/api/admin/cost-session/redeem'&&request.method==='POST')return await redeemAdminTicket(request,env,await readJson(request,4096));
  if(url.pathname.startsWith('/api/admin/cost'))return await adminCostRoutes(request,env,url,request.method==='POST'?await readJson(request,4096):undefined);
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
   if(url.pathname==='/api/admin/realtime/check'&&request.method==='POST'){
    await consume(env,'admin-realtime-check',3,60);
    return reply(await checkRealtimeConnection(env,upstream));
   }
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
  if(url.pathname==='/api/account'&&request.method==='GET'){const user=await enrichUser(env,await accountUser(request,env));return reply({user,methods:{password:!!env.DB,phone:phoneReady(env),email:false,wechat:false}});}
  if(url.pathname==='/api/account/register/challenge'&&request.method==='POST'){const result=await createRegistrationChallenge(request,env,await readJson(request,4096));return reply(result.data,200,{'Set-Cookie':result.cookie});}
  if(['/api/account/register/password','/api/account/login/password'].includes(url.pathname)&&request.method==='POST'){const result=await passwordAccount(request,env,await readJson(request,4096),url.pathname.includes('/register/'));await enrichUser(env,result.user);return reply({user:result.user},200,{'Set-Cookie':result.cookie});}
  if(url.pathname==='/api/account/phone/send'&&request.method==='POST')return reply(await sendPhoneCode(request,env,await readJson(request,4096),upstream));
  if(url.pathname==='/api/account/login/phone'&&request.method==='POST'){const result=await verifyPhoneCode(request,env,await readJson(request,4096),upstream);await enrichUser(env,result.user);return reply({user:result.user},200,{'Set-Cookie':result.cookie});}
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
  if(url.pathname==='/api/member/status'&&request.method==='GET'){
   const member=await memberSession(request,env),user=await accountUser(request,env);
   return reply({member:!!member,paidMember:!!member&&!member.trial,tier:member?.tier||'none',trial:user?await trialInfo(env,user.id):{eligible:false,grantedMinutes:0,usedMinutes:0,remainingMinutes:0},sharedReady:sharedReady(env)});
  }
  if(url.pathname==='/api/member/login'&&request.method==='POST'){
   const data=await readJson(request,4096);const membership=await loginMember(request,env,data.code);return reply({member:membership.active,paidMember:membership.active,tier:membership.tier,membership,sharedReady:sharedReady(env)});
  }
  if(url.pathname==='/api/member/logout'&&request.method==='POST'){
   await readJson(request,4096);return reply({member:false,sharedReady:sharedReady(env)},200,{'Set-Cookie':await signOutAccount(request,env)});
  }
  if(url.pathname==='/api/openai/status'&&request.method==='GET'){
   const availability=await realtimeAvailability(request,env);if(!availability.available)return reply(availability);
   const usage=await myUsage(request,env);
   if(usage.minutes!==null&&usage.remainingMinutes<=0)return reply({available:false,code:'translation_quota_exhausted',message:usage.tier==='trial'?'1 小时免费翻译已用完，请开通会员继续。':'本期 30 小时翻译额度已用完，请等待下期重置或联系客服。'});
   if(usage.paused)return reply({available:false,message:'本站已暂停新增 AI 消耗，请稍后再试。'});
   if(usage.restrictedUntil>Date.now())return reply({available:false,message:'账号服务暂时受限，请在个人中心查看。'});
   return reply(await recordingAvailability(request,env));
  }
  if(!['/api/openai/responses','/api/openai/token'].includes(url.pathname))return reply({error:{message:'Not found'}},404);
  if(request.method!=='POST')return reply({error:{message:'Method not allowed'}},405);
  if(request.headers.get('X-Access-Mode')!=='member')return reply({error:{message:'请登录并开通会员后使用。'}},401);
  const data=await readJson(request);let payload;
  if(url.pathname.endsWith('/token')){
   if(!await memberSession(request,env))throw new MemberError('请先登录并开通会员。',401);
   if(!sharedReady(env))throw new MemberError('管理员尚未配置共享 API',503);
   throw new MemberError('此版本已升级，请刷新页面后重新开始录音。',410);
  }else{
   if(typeof data.input!=='string'||data.instructions!==TRANSLATION_INSTRUCTIONS)return reply({error:{message:'输入格式不正确'}},400);
   if(data.input.length+data.instructions.length>80000)return reply({error:{message:'输入内容过长，请减少参考资料后重试。'}},413);
   payload={...(data.stream===true?{stream:true}:{}),model:TEXT_MODEL,input:data.input,instructions:TRANSLATION_INSTRUCTIONS,store:false,max_output_tokens:Math.max(1,Math.min(Math.floor(Number(data.max_output_tokens))||1800,1800))};
  }
  const member=await memberSession(request,env);if(!member)throw new MemberError('请先登录。',401);
  await verifyTrialTranslation(env,member,data);
  await allowSharedRequest(request,env,'text',(data.input?.length||0)+(data.instructions?.length||0));
  return await meteredText(request,env,payload,upstream);
 }catch(error){return reply({error:{message:error instanceof MemberError?error.message:'请求处理失败或服务暂不可用，请稍后重试。'}},error instanceof MemberError?error.status:503);}
}
export default {fetch(request,env,ctx){return handle(request,fetch,env,ctx?.waitUntil?{waitUntil:task=>ctx.waitUntil(task)}:{});}};

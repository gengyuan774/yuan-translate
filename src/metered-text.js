import {reserve,settle} from './service-ledger.js';
import {translationStream} from './translation-proxy.js';
import {responseText} from './text-stream.js';
import {upstreamError} from './upstream-error.js';
import {MemberError} from './errors.js';
export async function meteredText(request,env,payload,upstream){
 // UTF-8 bytes bound the tokenizer's input; leave room for provider framing.
 const inputTokens=new TextEncoder().encode(payload.instructions+payload.input).length+1024;
 const row=await reserve(request,env,{kind:'text',inputTokens,outputTokens:payload.max_output_tokens});
 let dispatched=false,settled=false;
 try{
  dispatched=true;
  const response=await upstream('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000),redirect:'manual'});
  if(response.status>=300&&response.status<400){await settle(env,row,{providerAccepted:false});settled=true;throw new MemberError('翻译服务返回异常跳转，请联系管理员。',503);}
  const requestId=response.headers.get('x-request-id');
  if(response.ok&&payload.stream){
   if(!response.headers.get('Content-Type')?.includes('text/event-stream'))throw new MemberError('翻译服务未返回预期格式，请重试。',503);
   settled=true;
   return new Response(translationStream(response.body,{finish:result=>settle(env,row,{...result,providerAccepted:true,requestId})}),{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'}});
  }
  const result=await response.json().catch(()=>null);
  const success=response.ok&&result?.status!=='incomplete'&&!!responseText(result||{}).trim();
  await settle(env,row,{success,usage:result?.usage,providerAccepted:response.ok||response.status>=500,requestId});settled=true;
  if(!response.ok)return Response.json({error:upstreamError(response.status,result?.error)},{status:[401,403].includes(response.status)?503:response.status,headers:{'Cache-Control':'no-store'}});
  if(!success)throw new MemberError('翻译结果未完整生成，额度已返还，请稍后重试。',503);
  return Response.json(result,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }finally{if(!settled)await settle(env,row,{providerAccepted:dispatched});}
}

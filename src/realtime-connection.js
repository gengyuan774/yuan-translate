import {MemberError} from './errors.js';
import {upstreamError} from './upstream-error.js';
import {transcriptionConfig} from './languages.js';

// Shared by the relay and the administrator's no-audio connection check.
export async function openTranscription(env,upstream){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 try{
  const response=await upstream('https://api.openai.com/v1/realtime?intent=transcription',{headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,Upgrade:'websocket'},redirect:'manual',signal:controller.signal});
  if(!response.webSocket){
   const data=await response.json().catch(()=>null),failure=upstreamError(response.status,data?.error);
   const error=new MemberError(failure.message,503);error.diagnostic={code:failure.code,status:response.status};throw error;
  }
  response.webSocket.accept();return response.webSocket;
 }catch(error){
  if(error.diagnostic)throw error;
  const failure=new MemberError('网站服务器暂时无法连接语音服务，请稍后重试。',503);
  failure.diagnostic={code:'upstream_transport',name:String(error?.name||'Error'),detail:String(error?.message||'Connection failed').replaceAll(env.OPENAI_API_KEY||'unused-key','[hidden]').replace(/sk-[\w-]+/g,'[hidden]').slice(0,400)};
  throw failure;
 }finally{clearTimeout(timer);}
}
export async function checkRealtimeConnection(env,upstream,{holdMs=0}={}){
 let socket;
 try{
  socket=await openTranscription(env,upstream);
  await new Promise((resolve,reject)=>{
   let done=false;
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
   const timer=setTimeout(()=>finish(new MemberError('语音会话配置确认超时。',503)),10000);
   socket.addEventListener('message',event=>{
    let data;try{data=JSON.parse(event.data);}catch{return;}
    if(['session.updated','transcription_session.updated'].includes(data.type))finish();
    if(data.type==='error'){const failure=upstreamError(400,data.error);const error=new MemberError(failure.message,503);error.diagnostic={code:failure.code};finish(error);}
   });
   socket.addEventListener('close',()=>finish(new MemberError('语音服务在确认配置前断开。',503)));
   socket.addEventListener('error',()=>finish(new MemberError('语音服务连接异常。',503)));
   try{socket.send(JSON.stringify({type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:transcriptionConfig('en','Connection check','accurate'),turn_detection:null}}}}));}catch(error){finish(new MemberError('语音会话配置发送失败。',503));}
  });
  if(holdMs){
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,holdMs);
    const failed=()=>{clearTimeout(timer);reject(new MemberError('持续连接检查期间语音连接中断。',503));};
    socket.addEventListener('close',failed);socket.addEventListener('error',failed);
   });
  }
  return {available:true,configured:true,...(holdMs?{heldMs:holdMs}:{})};
 }
 catch(error){return {available:false,error:{message:error.message,...error.diagnostic}};}
 finally{try{socket?.close(1000,'connection check complete');}catch{}}
}

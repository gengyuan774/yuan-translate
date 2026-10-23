import {issueAudioProof} from './audio-proof.js';
import {MemberError} from './errors.js';
import {allowSharedRequest} from './member.js';
import {validLanguage,transcriptionConfig} from './languages.js';
import {openTranscription} from './realtime-connection.js';
import {restrictAbuse} from './service-admin.js';
import {validTranslationMode} from './models.js';
import {acquireLease,releaseLease,renewLease,reserve,settle,settings,serviceBudgetState,recordingAvailability} from './service-ledger.js';
// Audio is held locally for at most one turn. Nothing billable is forwarded
// before both quota and full-turn cost have been atomically reserved.
export class MeteredAudio{
 constructor(request,env,lease,send,emit){Object.assign(this,{request,env,lease,send,emit});this.chunks=[];this.bytes=0;this.uncommitted=[];this.items=new Map();this.seenItems=new Set();this.pending=new Set();this.closed=false;this.sentSamples=0;this.started=Date.now();}
 async append(audio){
  if(typeof audio!=='string'||audio.length>100000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio))throw new MemberError('语音数据格式不正确',400);
  const size=atob(audio).length;if(size%2)throw new MemberError('语音数据格式不正确',400);
  if(this.bytes+size>48000*12)throw new MemberError('单段语音过长，请重新连接。',400);
  this.bytes+=size;this.chunks.push(audio);
 }
 async commit(){
  if(!this.bytes)return;
  if(this.pending.size>=3)throw new MemberError('语音识别积压，请暂停后重新连接。',429);
  // Bound accelerated uploads, while allowing a short reconnection backlog.
  if((this.sentSamples+this.bytes/2)/24000>(Date.now()-this.started)/1000+45){const error=new MemberError('语音发送异常，已停止连接。',429);error.abuse=true;throw error;}
  const row=await reserve(this.request,this.env,{kind:'audio',audioMs:Math.ceil(this.bytes/48),lease:this.lease});
  this.pending.add(row);this.uncommitted.push(row);this.sentSamples+=this.bytes/2;
  try{for(const audio of this.chunks)this.send({type:'input_audio_buffer.append',audio});this.send({type:'input_audio_buffer.commit'});}
  catch(error){await settle(this.env,row,{providerAccepted:true});this.pending.delete(row);throw error;}
  finally{this.chunks=[];this.bytes=0;}
 }
 async event(event){
  if(event.type==='input_audio_buffer.committed'){
   if(this.seenItems.has(event.item_id))return;this.seenItems.add(event.item_id);
   const row=this.uncommitted.shift();if(row)this.items.set(event.item_id,row);
  }
  if(['conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed'].includes(event.type)){
   const row=this.items.get(event.item_id);
   if(row){
    const completed=await settle(this.env,row,{success:event.type.endsWith('.completed'),providerAccepted:true});this.pending.delete(row);this.items.delete(event.item_id);
    if(event.type.endsWith('.completed')&&!completed){this.emit({type:'conversation.item.input_audio_transcription.failed',item_id:event.item_id});this.emit({type:'error',error:{message:'此段识别结果返回过晚，时长已返还，请重新录入此段。'}});return;}
    if(completed&&typeof event.transcript==='string'&&event.transcript.trim())event={...event,audioProof:await issueAudioProof(this.env,this.lease.accountId,row.id,event.transcript||'')};
   }else if(event.type.endsWith('.completed'))return;
  }
  if(event.type==='error'){
   // Do not publish arbitrary provider messages (they may contain credentials).
   this.emit({type:'error',error:{message:'语音识别服务出现错误，未完成的额度会自动返还。'}});return;
  }
  // Explicitly allow only transcription events; never expose session metadata.
  if(['session.updated','transcription_session.updated'].includes(event.type))this.emit({type:event.type});
  else if(['input_audio_buffer.committed','conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed'].includes(event.type)){
   const {type,item_id,previous_item_id,delta,transcript,language,audioProof}=event;this.emit({type,item_id,previous_item_id,delta,transcript,language,...(audioProof?{audioProof}:{})});
  }
 }
 async close(){
  if(this.closed)return;this.closed=true;
  for(const row of this.pending)await settle(this.env,row,{providerAccepted:true});
  this.pending.clear();this.chunks=[];await releaseLease(this.env,this.lease);
 }
}
export function safeSession(data,title,mode){
 const trans=data.session?.audio?.input?.transcription,languages=trans?.languages;
 const language=Array.isArray(languages)&&languages.length===1?languages[0]:languages===undefined?'auto':null;
 if(!validLanguage(language)||!validTranslationMode(mode))throw new MemberError('请选择支持的语言与翻译模式。',400);
 if(trans?.model!==transcriptionConfig(language,title,mode).model)throw new MemberError('不支持此识别模型。',400);
 return {type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:transcriptionConfig(language,title,mode),turn_detection:null}}}};
}
function rejectedSocket(runtime,error){
 const pair=runtime.pairFactory?runtime.pairFactory():new WebSocketPair(),client=pair[0],server=pair[1];server.accept();
 server.send(JSON.stringify({type:'error',error}));server.close(1011,'connection unavailable');
 return runtime.upgrade?runtime.upgrade(client):new Response(null,{status:101,webSocket:client});
}
export async function realtimeRelay(request,env,upstream,runtime={}){
 if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new MemberError('需要实时连接',426);
 if(request.headers.get('Origin')!==new URL(request.url).origin)throw new MemberError('不允许跨站连接',403);
 const query=new URL(request.url).searchParams,title=(query.get('title')||'课堂').slice(0,120),code=query.get('language')||'en',mode=query.get('mode')||'accurate';
 if(!validLanguage(code)||!validTranslationMode(mode))throw new MemberError('语言或翻译模式不正确',400);
 await allowSharedRequest(request,env,'token');let lease;
 try{lease=await acquireLease(request,env);}catch(error){
  if(error instanceof MemberError&&error.status===409){const conflict=await recordingAvailability(request,env);if(conflict.code==='recording_busy')return rejectedSocket(runtime,conflict);}
  throw error;
 }
 let socket;
 try{
  socket=await openTranscription(env,upstream);
 }catch(error){
  console.warn('realtime_connection_failed',JSON.stringify({code:error.diagnostic?.code,status:error.diagnostic?.status}));await releaseLease(env,lease);
  // Browsers cannot read an HTTP error body from a rejected WebSocket upgrade.
  // Once account checks passed, deliver only our safe error over the socket.
  return rejectedSocket(runtime,{message:error instanceof MemberError?error.message:'网站服务器暂时无法连接语音服务，请稍后重试。',code:error.diagnostic?.code});
 }
 const pair=runtime.pairFactory?runtime.pairFactory():new WebSocketPair(),client=pair[0],server=pair[1];server.accept();
 let closed=false,queue=Promise.resolve(),queued=0,eventQueue=Promise.resolve(),timer,configured=false;
 const emit=event=>{if(!closed&&server.readyState===1)server.send(JSON.stringify(event));};
 const audio=new MeteredAudio(request,env,lease,event=>socket.send(JSON.stringify(event)),emit);
 const close=(message,retryable=false)=>{const task=(async()=>{
  if(closed)return;emit({type:'error',error:{message:message||'语音连接已结束，请重新连接。',retryable}});closed=true;clearInterval(timer);
  try{socket.close(1000,'closed');}catch{}try{server.close(1000,'closed');}catch{}
  await queue.catch(()=>{});await eventQueue.catch(()=>{});await audio.close();
 })();runtime.waitUntil?.(task.catch(()=>console.warn('realtime_cleanup_failed')));return task;};
 server.addEventListener('message',event=>{
  if(closed)return;if(typeof event.data!=='string'||event.data.length>110000||++queued>100){void restrictAbuse(env,lease.accountId,'实时连接发送异常（频率或大小）').then(()=>close('发送异常，账号已临时限制 15 分钟。')).catch(()=>close('语音发送异常，已停止连接。'));return;}
  queue=queue.then(async()=>{
   if(closed)return;const data=JSON.parse(event.data);
   if(data.type==='session.update'){
    socket.send(JSON.stringify(safeSession(data,title,mode)));configured=true;
   }else if(data.type==='connection.ping'&&configured)emit({type:'connection.pong'});
   else if(data.type==='input_audio_buffer.append'&&configured)await audio.append(data.audio);
   else if(data.type==='input_audio_buffer.commit'&&configured)await audio.commit();
   else throw new MemberError('不支持的语音请求。',400);
  }).catch(error=>{if(error instanceof MemberError&&error.abuse===true)void restrictAbuse(env,lease.accountId,'语音积压或发送速度异常').catch(()=>{});void close(error instanceof MemberError?error.message:'实时服务暂不可用，请重新连接。');}).finally(()=>queued--);
 });
 socket.addEventListener('message',event=>{
  eventQueue=eventQueue.then(()=>audio.event(JSON.parse(event.data))).catch(()=>{void close('识别结果处理失败，未完成额度会自动返还。');});
 });
 socket.addEventListener('close',()=>{void close(undefined,true);});socket.addEventListener('error',()=>{void close('语音服务连接中断，正在尝试恢复。',true);});
 server.addEventListener('close',()=>{void close();});server.addEventListener('error',()=>{void close();});
 let checking=false;
 timer=setInterval(async()=>{
  if(closed||checking)return;checking=true;
  try{await renewLease(request,env,lease);const b=await serviceBudgetState(env),s=await settings(env);
   if(s.paused||(b.hardCents!==null&&(b.spentCny+b.reservedCny)*100>=b.hardCents))throw new MemberError('本站已达到紧急预算，已暂停新增消耗。',503);
  }catch(error){void close(error instanceof MemberError?error.message:'服务检查失败，请重新连接。');}finally{checking=false;}
 },15000);
 return runtime.upgrade?runtime.upgrade(client):new Response(null,{status:101,webSocket:client});
}

import {reconnectWithBackoff} from './connection-recovery.js';
import {translationMode} from './models.js';
import {transcriptionConfig,language,setSessionLanguage} from './languages.js';
import {authHeaders,accessConfig} from './access.js';
import {Buffer} from 'buffer';
import {getSession,saveSession,getMajorPreference,getTranslationModePreference,accountId} from './storage.js';
import {AudioTurns,translateSegment} from './core.js';
import {TranscriptMerger} from './transcript-merge.js';
import {busy,getKey,complete} from './local-api.js';
const lastOffset=session=>{const row=session.segments.at(-1);return row?.sourceParts?.at(-1)?.offset??row?.offset??0;};
export class BrowserLive{
 constructor({connectionOwner=crypto.randomUUID()}={}){this.connectionOwner=connectionOwner;this.readyState=0;this.bufferedAmount=0;this.paused=true;this.pending=0;this.meta=[];this.queue=Promise.resolve();this.jobs=new Set();this.receivedTurns=new Set();this.turnRows=[];this.merger=new TranscriptMerger({submit:row=>this.enqueueTranslation(row),remove:row=>{this.session.segments=this.session.segments.filter(item=>item!==row);}});this.closed=false;this.closing=false;setTimeout(()=>{if(!this.closed){this.readyState=1;this.onopen?.();}},0);}
 emit(value){this.onmessage?.({data:JSON.stringify(value)});}
 persist(){if(!Object.hasOwn(this,'owner'))this.owner=accountId();return saveSession(this.session,{background:true,deferCloud:this.session.status==='recording',owner:this.owner}).catch(e=>{this.emit({type:'warning',message:e.message});});}
 warn(message){if(this.session){this.session.warnings.push(message);this.persist();}this.emit({type:'warning',message});}
 resetIdle(){
  this.lastTranscriptAt=Date.now();clearInterval(this.idleTimer);
  this.idleTimer=setInterval(()=>this.checkIdle(),1000);
 }
 checkIdle(){
  if(this.closed||this.closing||this.paused||Date.now()-this.lastTranscriptAt<10*60*1000)return;
  this.paused=true;this.cancelRecovery();this.turns?.flush();this.merger.flush();this.session.status='paused';this.persist();
  this.releasePausedConnection();
  this.emit({type:'idle',message:'连续 10 分钟没有新的语音识别内容，已自动暂停。点击继续录音可恢复。'});
 }
 noteTranscript(text){if(!this.paused&&typeof text==='string'&&text.trim())this.lastTranscriptAt=Date.now();}
 async recoverConnection(message='连接中断，正在自动重连…'){
  if(this.closed||this.closing||this.finishingRequested||this.paused||this.renewing)return this.renewal;
  this.renewing=true;this.reconnecting=true;this.replayed=false;this.audioBacklog=[];this.backlogBytes=0;
  const controller=new AbortController();this.recoveryController=controller;
  this.drainTranscripts(true);this.merger.flush();this.pending=0;this.meta=[];
  this.warn('录音连接中断，正在自动恢复。中断期间未录入的语音无法补回。');
  this.emit({type:'recovering',message});
  this.renewal=(async()=>{
   try{
    await reconnectWithBackoff(signal=>this.connect(true,signal),{signal:controller.signal,onWaiting:text=>this.emit({type:'recovering',message:text})});
    if(!this.paused&&!this.closed&&!controller.signal.aborted){this.emit({type:'recovered',message:'连接已恢复，继续记录这节课。请补充中断期间未录入的内容。'});this.emit({type:'ready'});}
   }catch(error){
    if(!controller.signal.aborted&&!this.closed){this.paused=true;this.session.status='paused';await this.persist();this.emit({type:'fatal',message:'自动重连未完成：'+error.message,...(error.code==='recording_busy'?{code:error.code,recording:error.recording}:{})});}
   }finally{this.renewing=false;this.reconnecting=false;this.audioBacklog=[];this.backlogBytes=0;if(this.recoveryController===controller)this.recoveryController=null;if(this.paused)this.releasePausedConnection();}
  })();return this.renewal;
 }
 stopHeartbeat(){clearInterval(this.heartbeatTimer);clearTimeout(this.pongTimer);}
 startHeartbeat(){
  this.stopHeartbeat();this.lastPongAt=Date.now();this.lastHeartbeatCheck=Date.now();
  this.heartbeatTimer=setInterval(()=>{
   if(this.closed||this.paused||this.renewing)return;
   const now=Date.now();if(now-this.lastHeartbeatCheck>30000)this.lastPongAt=now;this.lastHeartbeatCheck=now;
   if(now-this.lastPongAt>45000){void this.recoverConnection('连接长时间未回应，正在自动恢复…');return;}
   if(this.upstream?.readyState===1)this.upstream.send(JSON.stringify({type:'connection.ping'}));
  },15000);
 }
 verifyConnection(){
  if(this.closed||this.paused||this.renewing)return;
  if(this.upstream?.readyState!==1){void this.recoverConnection();return;}
  const sent=Date.now();this.lastPongAt=sent;clearTimeout(this.pongTimer);
  this.upstream.send(JSON.stringify({type:'connection.ping'}));
  this.pongTimer=setTimeout(()=>{if(!this.closed&&!this.paused&&!this.renewing&&this.lastPongAt<=sent)void this.recoverConnection('返回页面后连接未回应，正在自动恢复…');},8000);
 }
 cancelRecovery(){this.recoveryController?.abort();}
 async renew(){
  if(this.closed||this.closing||this.paused||this.renewing)return;
  this.renewing=true;this.replayed=false;this.audioBacklog=[];this.backlogBytes=0;
  this.renewal=(async()=>{
   let failure;
   try{
    this.turns?.flush();const deadline=Date.now()+20000;
    while(this.pending>0&&!this.closed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    if(this.closed)return;
    if(this.pending)this.warn('续接时部分语音未识别完成，原有课堂记录已保留。');
    this.pending=0;this.meta=[];
    this.merger.flush();await this.connect(true);
   }catch(error){failure=error;}
   finally{this.renewing=false;this.audioBacklog=[];this.backlogBytes=0;if(this.paused)this.releasePausedConnection();}
   if(failure&&!this.paused&&!this.closed)return this.recoverConnection('自动续接遇到网络中断，正在重试…');
  })();
  return this.renewal;
 }
 send(data){
  if(this.closed)return;
  if(data instanceof ArrayBuffer){this.checkIdle();if(this.reconnecting)return;if(this.renewing&&!this.replayed&&!this.paused&&!this.closing){if(this.backlogBytes+data.byteLength>24000*2*45){this.paused=true;this.emit({type:'fatal',message:'自动续接耗时过长，已暂停录音，请重新连接。'});return;}this.audioBacklog.push(Buffer.from(data));this.backlogBytes+=data.byteLength;return;}if(!this.paused&&this.upstream?.readyState===1&&!this.closing){this.turns.push(Buffer.from(data));this.bufferedAmount=this.upstream.bufferedAmount;}return;}
  let e;try{e=JSON.parse(data);}catch{return;}
  this.command(e).catch(error=>{this.emit({type:'fatal',message:error.message,...(error.code==='recording_busy'?{code:error.code,recording:error.recording}:{})});});
 }
 releasePausedConnection(){
  clearTimeout(this.pauseTimer);
  if(!this.paused||this.closed||this.closing)return;
  this.pauseDeadline??=Date.now()+20000;
  if(this.pending&&Date.now()<this.pauseDeadline){this.pauseTimer=setTimeout(()=>this.releasePausedConnection(),250);return;}
  this.pauseDeadline=null;clearTimeout(this.limitTimer);this.stopHeartbeat();
  if(this.upstream){this.upstream.onclose=null;this.upstream.onmessage=null;this.upstream.onerror=null;this.upstream.close();this.upstream=null;}
 }
 async command(e){
  if(e.type==='start'){
   if(this.session)return;getKey();if(busy.has(e.id))throw new Error('当前课堂正在处理，请稍候');
   this.owner=accountId();this.session=await getSession(e.id);this.session.major=await getMajorPreference();this.session.translationMode=await getTranslationModePreference();busy.add(e.id);this.session.summary='';this.started=Date.now();this.base=lastOffset(this.session)+1000;await this.connect();
  }
  if(e.type==='pause'){this.paused=true;this.cancelRecovery();this.turns?.flush();this.merger.flush();this.session.status='paused';await this.persist();this.emit({type:'paused'});this.releasePausedConnection();}
  if(e.type==='resume'){
   clearTimeout(this.pauseTimer);this.pauseDeadline=null;
   if(this.finishingRequested)return;if(this.renewing){await this.renewal;if(this.closed||this.closing)return;}this.resetIdle();
   if(this.upstream?.readyState===1&&Date.now()-this.connectedAt<54*60*1000){
    if(this.appliedLanguage!==language(this.session.sourceLanguage).code){
     this.paused=true;
     if(language(this.session.sourceLanguage).code==='auto'){
      // Omitting a field in an update may retain the old hint. Start a fresh
      // session for auto detection, after the previous audio has finished.
      const deadline=Date.now()+20000;
      while(this.pending>0&&!this.closed&&!this.closing&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      if(this.closed||this.closing)return;
      if(this.pending>0)throw new Error('上一段语音仍在识别，请稍后点击继续录音。');
      this.meta=[];this.started=Date.now();this.base=lastOffset(this.session)+1000;
      await this.connect();return;
     }
     this.connectTimer=setTimeout(()=>{this.paused=true;this.emit({type:'fatal',message:'语言切换超时，请重新连接'});this.upstream.close();},20000);this.sendConfiguration();return;
    }
    this.paused=false;this.startHeartbeat();this.session.status='recording';await this.persist();this.emit({type:'ready'});}
   else {this.paused=true;if(this.pending)this.warn('重新连接前部分语音未识别完成，记录可能存在缺失。');this.pending=0;this.meta=[];this.started=Date.now();this.base=lastOffset(this.session)+1000;await this.connect();}
  }
  if(e.type==='finish'&&!this.closing&&!this.finishingRequested){this.finishingRequested=true;this.finishWithSummary=e.autoSummary===true;this.paused=true;this.cancelRecovery();await this.renewal;if(this.closed)return;this.closing=true;this.paused=true;this.turns?.flush();this.merger.flush();this.session.status='finishing';await this.persist();this.emit({type:'status',message:'正在收齐最后的字幕…'});this.finishTimer=setTimeout(()=>this.finalize(true),20000);this.finalize();}
 }
 async changeLanguage(code){
  if(!this.session||!this.paused||this.closing)throw new Error('请先暂停录音再切换语言');
  this.merger.flush();const previous=this.session.sourceLanguage;setSessionLanguage(this.session,code);
  try{await saveSession(this.session);}catch(error){this.session.sourceLanguage=previous;throw error;}return structuredClone(this.session);
 }
 sendConfiguration(){
  this.configuringLanguage=language(this.session.sourceLanguage).code;
  this.upstream.send(JSON.stringify({type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:transcriptionConfig(this.configuringLanguage,this.session.title,this.session.translationMode),turn_detection:null}}}}));
 }
 async connect(waitUntilReady=false,signal){
  if(signal?.aborted)throw new DOMException('恢复已取消','AbortError');
  const settings=translationMode(this.session.translationMode);this.merger.maxWait=settings.mergeWait;
  this.connectionAbortCleanup?.();this.stopHeartbeat();
  if(this.upstream){this.drainTranscripts(true);this.merger.flush();this.upstream.onclose=null;this.upstream.onmessage=null;this.upstream.onerror=null;this.upstream.close();}clearTimeout(this.limitTimer);clearTimeout(this.connectTimer);
  const preflight=await fetch('/api/openai/status?owner='+this.connectionOwner,{headers:authHeaders(getKey()),cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
  if(signal?.aborted||this.closed)throw new DOMException('恢复已取消','AbortError');
  const availability=await preflight.json();if(!preflight.ok||availability.available===false){const error=new Error(availability.error?.message||availability.message||'无法建立录音连接');Object.assign(error,{status:preflight.status,code:availability.code,retryAt:availability.retryAt,recording:availability.recording});throw error;}
  const socketUrl=new URL('/api/openai/realtime',location.href);socketUrl.protocol=location.protocol==='https:'?'wss:':'ws:';
  socketUrl.searchParams.set('owner',this.connectionOwner);
  socketUrl.searchParams.set('title',this.session.title||'课堂');socketUrl.searchParams.set('mode',this.session.translationMode||'accurate');socketUrl.searchParams.set('language',language(this.session.sourceLanguage).code);
  const upstream=new WebSocket(socketUrl);this.upstream=upstream;this.connectedAt=Date.now();let bytes=0;
  const send=e=>{if(upstream.readyState===1)upstream.send(JSON.stringify(e));};
  this.turns=new AudioTurns(b=>{bytes+=b.length;send({type:'input_audio_buffer.append',audio:b.toString('base64')});},()=>{this.meta.push({sourceLanguage:language(this.session.sourceLanguage).code,offset:Math.max(this.base,this.base+Date.now()-this.started-bytes/48)});bytes=0;this.pending++;send({type:'input_audio_buffer.commit'});},settings);
  const connected=new Promise((resolve,reject)=>{this.connectedResolve=resolve;this.connectedReject=reject;});
  const cleanup=()=>{signal?.removeEventListener('abort',abort);if(this.connectionAbortCleanup===cleanup)this.connectionAbortCleanup=null;};
  const abort=()=>{cleanup();clearTimeout(this.connectTimer);this.connectedReject?.(new DOMException('恢复已取消','AbortError'));upstream.onclose=null;upstream.close();};
  this.connectionAbortCleanup=cleanup;signal?.addEventListener('abort',abort,{once:true});
  this.connectTimer=setTimeout(()=>{cleanup();this.connectedReject?.(new Error('实时连接超时'));if(!this.renewing){this.paused=true;this.emit({type:'fatal',message:'实时连接超时，请检查网络后重试'});}upstream.close();},20000);
  upstream.onopen=()=>this.sendConfiguration();
  upstream.onmessage=({data})=>this.handle(JSON.parse(data),upstream).catch(e=>this.warn(e.message));
  upstream.onerror=()=>{
   if(this.renewing){this.connectedReject?.(new Error('连接未建立，请检查网络。'));return;}
   if(this.hasRecorded&&!this.paused){void this.recoverConnection();return;}
   this.emit({type:'fatal',message:'无法建立实时连接，请稍后重试；若持续失败，请联系管理员。'});
  };
  upstream.onclose=()=>{
   cleanup();this.connectedReject?.(new Error('实时连接已断开'));clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);
   if(this.closed)return;if(this.closing){this.finalize(true);return;}if(this.renewing)return;
   if(this.hasRecorded&&!this.paused){void this.recoverConnection();return;}
   this.paused=true;this.drainTranscripts(true);this.merger.flush();this.emit({type:'disconnected'});
  };
  if(waitUntilReady)return connected;connected.catch(()=>{});
 }
 async handle(e,sourceSocket){
  const s=this.session;if(this.closed||this.finalizing||!s||(sourceSocket&&sourceSocket!==this.upstream))return;
  if(e.type==='connection.pong'){this.lastPongAt=Date.now();clearTimeout(this.pongTimer);return;}
  if(e.type==='session.updated'||e.type==='transcription_session.updated'){
   const resolve=this.connectedResolve;this.hasRecorded=true;this.startHeartbeat();this.connectionAbortCleanup?.();this.appliedLanguage=this.configuringLanguage;clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);
   if(this.renewing){for(const audio of this.audioBacklog)this.turns.push(audio);this.audioBacklog=[];this.backlogBytes=0;this.replayed=true;if(this.paused)this.turns.flush();}
   else {this.paused=false;this.resetIdle();}
   s.status=this.paused?'paused':'recording';await this.persist();if(sourceSocket&&sourceSocket!==this.upstream)return;this.emit({type:'session',session:s});if(!this.renewing)this.emit({type:'ready'});
   resolve?.();
   this.limitTimer=setTimeout(()=>this.renew(),Math.max(0,55*60*1000-(Date.now()-this.connectedAt)));
  }
  if(e.type==='input_audio_buffer.committed'){
   const meta=this.meta.shift()||{sourceLanguage:language(s.sourceLanguage).code,offset:this.base+Date.now()-this.started};
   if(!this.receivedTurns.has(e.item_id)&&!s.segments.some(x=>x.id===e.item_id)){
    const row={id:e.item_id,...meta,source:'',translation:'',state:'transcribing'};s.segments.push(row);this.turnRows.push(row);
   }
   await this.persist();
  }
  if(e.type==='conversation.item.input_audio_transcription.delta'){
   if(!this.receivedTurns.has(e.item_id)){this.noteTranscript(e.delta);this.emit({type:'delta',id:e.item_id,delta:e.delta});}
  }
  if(e.type==='conversation.item.input_audio_transcription.completed'||e.type==='conversation.item.input_audio_transcription.failed'){
   if(this.receivedTurns.has(e.item_id))return;this.receivedTurns.add(e.item_id);
   let row=s.segments.find(x=>x.id===e.item_id);
   if(!row){row={id:e.item_id,sourceLanguage:language(s.sourceLanguage).code,offset:this.base+Date.now()-this.started,source:'',translation:''};s.segments.push(row);this.turnRows.push(row);}
   if(!this.turnRows.includes(row))this.turnRows.push(row);
   row.finalReceived=true;this.pending=Math.max(0,this.pending-1);
   if(e.type.endsWith('.failed')){row.state='failed';this.warn('有一段语音转写失败，课堂记录存在缺失。');}
   else {row.source=e.transcript||'';if(typeof e.audioProof==='string'&&e.audioProof.length<=4096)row.audioProof=e.audioProof;this.noteTranscript(row.source);row.state='assembling';}
   this.drainTranscripts();
   if(this.paused||this.closing||this.finishingRequested)this.merger.flush();
   this.emit({type:'session',session:s});await this.persist();if(this.closing)this.finalize();
  }
  if(e.type==='error'){
   const message=String(e.error?.message||'实时识别出错，请重新连接。').replace(/sk-[\w-]+/g,'[已隐藏]'),error=Object.assign(new Error(message),{code:e.error?.code,recording:e.error?.recording});
   clearTimeout(this.connectTimer);this.connectedReject?.(error);
   if(e.error?.retryable&&this.hasRecorded&&!this.paused){if(!this.renewing)void this.recoverConnection(message);return;}
   // Recovery owns attempt errors so retryable failures do not become fatal UI events.
   if(this.reconnecting)return;
   this.paused=true;this.cancelRecovery();this.merger.flush();this.warn(message);this.emit({type:'fatal',message,...(e.error?.code==='recording_busy'?{code:e.error.code,recording:e.error.recording}:{})});
  }
 }
 drainTranscripts(force=false){
  while(this.turnRows.length){
   const row=this.turnRows[0];if(!row.finalReceived&&!force)break;
   this.turnRows.shift();
   if(!row.finalReceived||row.state==='failed'){this.merger.flush();continue;}
   this.merger.add(row);
  }
  // A missing earlier result must not block all subsequent classroom text.
  if(this.turnRows.some(row=>row.finalReceived)){
   if(!this.orderTimer)this.orderTimer=setTimeout(()=>{this.orderTimer=null;this.drainTranscripts(true);this.merger.flush();this.persist();this.emit({type:'session',session:this.session});},6000);
  }else {clearTimeout(this.orderTimer);this.orderTimer=null;}
 }
 enqueueTranslation(row){
  const s=this.session;row.state='translating';
  const job=this.queue.then(async()=>{
   try{if(row.source.trim()){const index=s.segments.indexOf(row);Object.assign(row,await translateSegment(s,getKey(),row.source,s.segments.slice(Math.max(0,index-2),index).map(x=>x.source).join('\n'),undefined,row.sourceLanguage,text=>{row.translation=text;if(!this.closed)this.emit({type:'translation',id:row.id,translation:text});},row));}row.state='translated';}
   catch(e){row.state='failed';row.error=e.message;this.warn('部分片段翻译失败，原文已保存。');}
   if(!this.closed)this.emit({type:'session',session:s});await this.persist();
  });
  this.queue=job.catch(()=>{});this.jobs.add(job);job.then(()=>this.jobs.delete(job),()=>this.jobs.delete(job));
 }
 async finalize(timeout=false){
  if(!this.closing||this.finalizing||(!timeout&&this.pending>0))return;this.finalizing=true;clearInterval(this.idleTimer);clearTimeout(this.finishTimer);clearTimeout(this.limitTimer);clearTimeout(this.connectTimer);
  if(timeout&&this.pending)this.warn('结束时部分语音转写尚未完成，可能缺少最后一段。');
  if(this.upstream){this.upstream.onclose=null;this.upstream.close();}
  this.drainTranscripts(true);this.merger.flush();
  const autoSummary=this.finishWithSummary===true&&accessConfig().paidMember===true;
  this.emit({type:'status',message:autoSummary?'正在完成翻译并生成总结…':'正在完成翻译并保存课堂…'});await Promise.allSettled([...this.jobs]);this.session.endedAt=new Date().toISOString();
  try{await complete(this.session,{autoSummary});}catch(e){this.warn(e.message+(autoSummary?'；原文已保存，可稍后重新生成总结。':'；课堂保存尚未完成，请重新打开记录检查。'));}
  this.emit({type:'finished',session:this.session,autoSummary});this.close();
 }
 close(){if(this.closed)return;this.cancelRecovery();this.connectionAbortCleanup?.();this.stopHeartbeat();this.drainTranscripts(true);this.merger.flush();this.closed=true;this.connectedReject?.(new Error('连接已结束'));this.readyState=3;clearInterval(this.idleTimer);clearTimeout(this.pauseTimer);clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);clearTimeout(this.finishTimer);if(this.upstream){this.upstream.onclose=null;this.upstream.close();}if(this.session){busy.delete(this.session.id);if(!this.finalizing){this.session.status='interrupted';this.persist();}}this.onclose?.();}
}

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
 constructor(){this.connectionOwner=crypto.randomUUID();this.readyState=0;this.bufferedAmount=0;this.paused=true;this.pending=0;this.meta=[];this.queue=Promise.resolve();this.jobs=new Set();this.receivedTurns=new Set();this.turnRows=[];this.merger=new TranscriptMerger({submit:row=>this.enqueueTranslation(row),remove:row=>{this.session.segments=this.session.segments.filter(item=>item!==row);}});this.closed=false;this.closing=false;setTimeout(()=>{if(!this.closed){this.readyState=1;this.onopen?.();}},0);}
 emit(value){this.onmessage?.({data:JSON.stringify(value)});}
 persist(){if(!Object.hasOwn(this,'owner'))this.owner=accountId();return saveSession(this.session,{background:true,deferCloud:this.session.status==='recording',owner:this.owner}).catch(e=>{this.emit({type:'warning',message:e.message});});}
 warn(message){if(this.session){this.session.warnings.push(message);this.persist();}this.emit({type:'warning',message});}
 resetIdle(){
  this.lastTranscriptAt=Date.now();clearInterval(this.idleTimer);
  this.idleTimer=setInterval(()=>this.checkIdle(),1000);
 }
 checkIdle(){
  if(this.closed||this.closing||this.paused||Date.now()-this.lastTranscriptAt<10*60*1000)return;
  this.paused=true;this.turns?.flush();this.merger.flush();this.session.status='paused';this.persist();
  this.releasePausedConnection();
  this.emit({type:'idle',message:'连续 10 分钟没有新的语音识别内容，已自动暂停。点击继续录音可恢复。'});
 }
 noteTranscript(text){if(!this.paused&&typeof text==='string'&&text.trim())this.lastTranscriptAt=Date.now();}
 async renew(){
  if(this.closed||this.closing||this.paused||this.renewing)return;
  this.renewing=true;this.replayed=false;this.audioBacklog=[];this.backlogBytes=0;
  this.renewal=(async()=>{
   try{
    this.turns?.flush();const deadline=Date.now()+20000;
    while(this.pending>0&&!this.closed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    if(this.closed)return;
    if(this.pending)this.warn('续接时部分语音未识别完成，原有课堂记录已保留。');
    this.pending=0;this.meta=[];
    this.merger.flush();await this.connect(true);
   }catch(error){this.paused=true;this.emit({type:'fatal',message:'自动续接失败：'+error.message+'。请点击继续录音。'});}
   finally{this.renewing=false;this.audioBacklog=[];this.backlogBytes=0;if(this.paused)this.releasePausedConnection();}
  })();
  return this.renewal;
 }
 send(data){
  if(this.closed)return;
  if(data instanceof ArrayBuffer){this.checkIdle();if(this.renewing&&!this.replayed&&!this.paused&&!this.closing){if(this.backlogBytes+data.byteLength>24000*2*45){this.paused=true;this.emit({type:'fatal',message:'自动续接耗时过长，已暂停录音，请重新连接。'});return;}this.audioBacklog.push(Buffer.from(data));this.backlogBytes+=data.byteLength;return;}if(!this.paused&&this.upstream?.readyState===1&&!this.closing){this.turns.push(Buffer.from(data));this.bufferedAmount=this.upstream.bufferedAmount;}return;}
  let e;try{e=JSON.parse(data);}catch{return;}
  this.command(e).catch(error=>{this.emit({type:'fatal',message:error.message});});
 }
 releasePausedConnection(){
  clearTimeout(this.pauseTimer);
  if(!this.paused||this.closed||this.closing)return;
  this.pauseDeadline??=Date.now()+20000;
  if(this.pending&&Date.now()<this.pauseDeadline){this.pauseTimer=setTimeout(()=>this.releasePausedConnection(),250);return;}
  this.pauseDeadline=null;clearTimeout(this.limitTimer);
  if(this.upstream){this.upstream.onclose=null;this.upstream.onmessage=null;this.upstream.onerror=null;this.upstream.close();this.upstream=null;}
 }
 async command(e){
  if(e.type==='start'){
   if(this.session)return;getKey();if(busy.has(e.id))throw new Error('当前课堂正在处理，请稍候');
   this.owner=accountId();this.session=await getSession(e.id);this.session.major=await getMajorPreference();this.session.translationMode=await getTranslationModePreference();busy.add(e.id);this.session.summary='';this.started=Date.now();this.base=lastOffset(this.session)+1000;await this.connect();
  }
  if(e.type==='pause'){this.paused=true;this.turns?.flush();this.merger.flush();this.session.status='paused';await this.persist();this.emit({type:'paused'});this.releasePausedConnection();}
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
    this.paused=false;this.session.status='recording';await this.persist();this.emit({type:'ready'});}
   else {this.paused=true;if(this.pending)this.warn('重新连接前部分语音未识别完成，记录可能存在缺失。');this.pending=0;this.meta=[];this.started=Date.now();this.base=lastOffset(this.session)+1000;await this.connect();}
  }
  if(e.type==='finish'&&!this.closing&&!this.finishingRequested){this.finishingRequested=true;this.paused=true;await this.renewal;if(this.closed)return;this.closing=true;this.paused=true;this.turns?.flush();this.merger.flush();this.session.status='finishing';await this.persist();this.emit({type:'status',message:'正在收齐最后的字幕…'});this.finishTimer=setTimeout(()=>this.finalize(true),20000);this.finalize();}
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
 async connect(waitUntilReady=false){
  const settings=translationMode(this.session.translationMode);this.merger.maxWait=settings.mergeWait;
  if(this.upstream){this.drainTranscripts(true);this.merger.flush();this.upstream.onclose=null;this.upstream.onmessage=null;this.upstream.onerror=null;this.upstream.close();}clearTimeout(this.limitTimer);clearTimeout(this.connectTimer);
  const preflight=await fetch('/api/openai/status',{headers:authHeaders(getKey()),cache:'no-store',signal:AbortSignal.timeout(20000)});
  const availability=await preflight.json();if(!preflight.ok||availability.available===false)throw new Error(availability.error?.message||availability.message||'无法建立录音连接');
  const socketUrl=new URL('/api/openai/realtime',location.href);socketUrl.protocol=location.protocol==='https:'?'wss:':'ws:';
  socketUrl.searchParams.set('owner',this.connectionOwner);
  socketUrl.searchParams.set('title',this.session.title||'课堂');socketUrl.searchParams.set('mode',this.session.translationMode||'accurate');socketUrl.searchParams.set('language',language(this.session.sourceLanguage).code);
  const upstream=new WebSocket(socketUrl);this.upstream=upstream;this.connectedAt=Date.now();let bytes=0;
  const send=e=>{if(upstream.readyState===1)upstream.send(JSON.stringify(e));};
  this.turns=new AudioTurns(b=>{bytes+=b.length;send({type:'input_audio_buffer.append',audio:b.toString('base64')});},()=>{this.meta.push({sourceLanguage:language(this.session.sourceLanguage).code,offset:Math.max(this.base,this.base+Date.now()-this.started-bytes/48)});bytes=0;this.pending++;send({type:'input_audio_buffer.commit'});},settings);
  const connected=new Promise((resolve,reject)=>{this.connectedResolve=resolve;this.connectedReject=reject;});
  this.connectTimer=setTimeout(()=>{this.paused=true;this.connectedReject?.(new Error('实时连接超时'));this.emit({type:'fatal',message:'实时连接超时，请检查网络后重试'});upstream.close();},20000);
  upstream.onopen=()=>this.sendConfiguration();
  upstream.onmessage=({data})=>this.handle(JSON.parse(data)).catch(e=>this.warn(e.message));
  upstream.onerror=()=>this.emit({type:'fatal',message:'实时连接失败，请检查网络及 API 权限'});
  upstream.onclose=()=>{this.connectedReject?.(new Error('实时连接已断开'));clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);if(this.closed)return;if(this.closing)this.finalize(true);else {this.paused=true;this.drainTranscripts(true);this.merger.flush();this.warn('实时连接已断开，断开期间的语音未记录。点击继续录音重新连接。');this.emit({type:'disconnected'});}};
  if(waitUntilReady)return connected;connected.catch(()=>{});
 }
 async handle(e){
  const s=this.session;if(this.closed||this.finalizing||!s)return;
  if(e.type==='session.updated'||e.type==='transcription_session.updated'){
   this.appliedLanguage=this.configuringLanguage;clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);
   if(this.renewing){for(const audio of this.audioBacklog)this.turns.push(audio);this.audioBacklog=[];this.backlogBytes=0;this.replayed=true;if(this.paused)this.turns.flush();}
   else {this.paused=false;this.resetIdle();}
   s.status=this.paused?'paused':'recording';await this.persist();this.emit({type:'session',session:s});if(!this.renewing)this.emit({type:'ready'});
   this.connectedResolve?.();
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
  if(e.type==='error'){this.paused=true;this.merger.flush();this.warn(String(e.error?.message||'实时识别出错').replace(/sk-[\w-]+/g,'[已隐藏]'));this.emit({type:'fatal',message:'实时识别出现错误，请检查提示后重新连接。'});}
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
  const autoSummary=accessConfig().tier!=='trial';
  this.emit({type:'status',message:autoSummary?'正在完成翻译并生成总结…':'正在完成翻译并保存课堂…'});await Promise.allSettled([...this.jobs]);this.session.endedAt=new Date().toISOString();
  try{await complete(this.session,{autoSummary});}catch(e){this.warn(e.message+(autoSummary?'；原文已保存，可稍后重新生成总结。':'；课堂保存尚未完成，请重新打开记录检查。'));}
  this.emit({type:'finished',session:this.session});this.close();
 }
 close(){if(this.closed)return;this.drainTranscripts(true);this.merger.flush();this.closed=true;this.connectedReject?.(new Error('连接已结束'));this.readyState=3;clearInterval(this.idleTimer);clearTimeout(this.pauseTimer);clearTimeout(this.connectTimer);clearTimeout(this.limitTimer);clearTimeout(this.finishTimer);if(this.upstream){this.upstream.onclose=null;this.upstream.close();}if(this.session){busy.delete(this.session.id);if(!this.finalizing){this.session.status='interrupted';this.persist();}}this.onclose?.();}
}

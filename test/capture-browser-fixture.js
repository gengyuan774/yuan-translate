// Explicit local simulation controls; no real microphone or private audio.
(()=>{
 const NativeContext=window.AudioContext,contexts=[],tracks=[],sockets=[];let hidden=false,sequence=0;
 window.AudioContext=class extends NativeContext{constructor(options){super(options);contexts.push(this);}};
 Object.defineProperty(document,'visibilityState',{get:()=>hidden?'hidden':'visible',configurable:true});
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{enumerateDevices:async()=>[{kind:'audioinput',deviceId:'qa-local',label:'Built-in QA Microphone'}],getUserMedia:async()=>{
  const context=new NativeContext({sampleRate:24000});await context.resume();const oscillator=context.createOscillator(),gain=context.createGain(),dest=context.createMediaStreamDestination();
  oscillator.frequency.value=440;gain.gain.value=.06;oscillator.connect(gain).connect(dest);oscillator.start();
  const track=dest.stream.getAudioTracks()[0],stop=track.stop.bind(track);let muted=false;
  Object.defineProperties(track,{label:{get:()=> 'Built-in QA Microphone'},muted:{get:()=>muted},getSettings:{value:()=>({deviceId:'qa-local'})}});
  track.stop=()=>{stop();oscillator.stop();void context.close();};tracks.push({track,mute:value=>{muted=value;track.dispatchEvent(new Event(value?'mute':'unmute'));}});return dest.stream;
 }}});
 window.WebSocket=class{
  static OPEN=1;static CLOSED=3;
  constructor(){this.readyState=0;this.bufferedAmount=0;sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},20);}
  event(value){if(this.readyState===1)this.onmessage?.({data:JSON.stringify(value)});}
  send(raw){const data=JSON.parse(raw);if(data.type==='session.update')setTimeout(()=>this.event({type:'session.updated'}),20);if(data.type==='connection.ping')this.event({type:'connection.pong'});
   if(data.type==='input_audio_buffer.commit'){const item_id='qa-'+(++sequence);this.event({type:'input_audio_buffer.committed',item_id});setTimeout(()=>this.event({type:'conversation.item.input_audio_transcription.completed',item_id,transcript:'Opportunity cost is the value of the next best alternative. Sentence '+sequence+'.'}),30);}}
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
 };
 window.addEventListener('DOMContentLoaded',()=>{
  const panel=document.createElement('section'),label=document.createElement('strong');label.textContent='本机模拟验收（非手机真机，不录制真实麦克风）';panel.append(label);
  const button=(label,action)=>{const b=document.createElement('button');b.textContent=label;b.onclick=action;panel.append(b);};
  button('模拟后台',()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
  button('模拟锁屏静音',()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));tracks.at(-1)?.mute(true);});
  button('模拟音频引擎暂停',async()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));await contexts.at(-1)?.suspend();});
  button('模拟冻结页面',()=>{hidden=true;document.dispatchEvent(new Event('freeze'));});
  button('返回前台',async()=>{hidden=false;tracks.at(-1)?.mute(false);await contexts.at(-1)?.resume();document.dispatchEvent(new Event('resume'));document.dispatchEvent(new Event('visibilitychange'));});
  button('模拟麦克风失效',()=>{const current=tracks.at(-1);current?.track.stop();current?.track.dispatchEvent(new Event('ended'));});
  button('模拟连接断开',()=>sockets.at(-1)?.close());
  document.querySelector('main').prepend(panel);
 });
})();

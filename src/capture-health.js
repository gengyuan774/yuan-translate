// A live WebSocket does not prove that the OS is still supplying microphone audio.
// Never recreate a live, system-muted track automatically: the user may have
// muted capture in browser controls. Wait for unmute or an explicit user action.
export async function resumeAudioContext(context,{timeoutMs=6000}={}){
 if(!context||context.state==='closed')throw new Error('录音设备已关闭，请点击继续录音重新连接。');
 if(context.state==='running')return;
 let timer;
 try{
  await Promise.race([context.resume(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('浏览器暂停了麦克风，请返回页面并点击继续录音。')),timeoutMs);})]);
  if(context.state!=='running')throw new Error('浏览器尚未恢复麦克风，请点击继续录音。');
 }finally{clearTimeout(timer);}
}

export function monitorCapture({active,visible,interrupted,available,now=Date.now,staleMs=6000,intervalMs=1000}){
 let track,context,cleanup=()=>{},lastFrameAt=now(),reported=false,notified=false,disposed=false;
 const healthy=()=>track?.readyState==='live'&&!track.muted&&context?.state==='running';
 const signal=reason=>{if(disposed||reported||!active())return;reported=true;notified=false;void Promise.resolve(interrupted(reason)).catch(()=>{});};
 const check=()=>{
  if(disposed)return;
  if(reported){if(!notified&&visible()&&healthy()){notified=true;void Promise.resolve(available()).catch(()=>{});}return;}
  if(!active())return;
  if(track?.readyState==='ended')signal('ended');
  else if(track?.muted)signal('muted');
  else if(context&&context.state!=='running')signal('context');
  else if(visible()&&now()-lastFrameAt>=staleMs)signal('stalled');
 };
 const timer=setInterval(check,intervalMs);
 return {
  bind(nextTrack,nextContext){
   cleanup();track=nextTrack;context=nextContext;lastFrameAt=now();
   const mute=()=>signal('muted'),end=()=>signal('ended'),state=()=>check();
   track?.addEventListener('mute',mute);track?.addEventListener('unmute',state);track?.addEventListener('ended',end);context?.addEventListener('statechange',state);
   cleanup=()=>{nextTrack?.removeEventListener('mute',mute);nextTrack?.removeEventListener('unmute',state);nextTrack?.removeEventListener('ended',end);nextContext?.removeEventListener('statechange',state);};
  },
  frame(){lastFrameAt=now();},
  returned(){lastFrameAt=now();},
  reset(){reported=false;notified=false;lastFrameAt=now();},
  check,
  dispose(){disposed=true;clearInterval(timer);cleanup();}
 };
}

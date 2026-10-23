const stopped=()=>new DOMException('恢复已取消','AbortError');
export function recoveryWait(ms,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(stopped());return;}
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);reject(stopped());};
  signal?.addEventListener('abort',abort,{once:true});
 });
}
const permanent=new Set(['recording_busy','translation_quota_exhausted','service_paused','account_restricted','insufficient_quota','upstream_authentication','upstream_access','upstream_configuration']);
export async function reconnectWithBackoff(connect,{signal,online=()=>globalThis.navigator?.onLine!==false,wait=recoveryWait,now=()=>Date.now(),onWaiting=()=>{},maxMs=180000}={}){
 const started=now();let attempts=0,lastError;
 const check=()=>{if(signal?.aborted)throw stopped();if(now()-started>=maxMs)throw lastError||new Error('自动重连已超时，请检查网络后继续录音。');};
 while(attempts<4){
  check();
  if(!online()){onWaiting('网络已离线，恢复网络后会自动重连。');await wait(Math.min(3000,maxMs-(now()-started)),signal);continue;}
  try{const result=await connect(signal);check();return result;}
  catch(error){
   if(signal?.aborted||error.name==='AbortError')throw stopped();
   if(permanent.has(error.code)||[401,402,403].includes(error.status))throw error;
   lastError=error;attempts++;if(attempts>=4)break;
   const delay=Math.max([1500,4000,8000][attempts-1],Number(error.retryAt||0)-now());
   if(delay>=maxMs-(now()-started))break;
   onWaiting(error.retryAt?'连接尝试暂时受限，等待后自动重连。':'连接中断，正在自动重连（'+attempts+'/4）…');
   await wait(delay,signal);
  }
 }
 throw lastError||new Error('自动重连失败，请点击继续录音。');
}

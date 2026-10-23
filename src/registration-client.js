const cancelled=()=>Object.assign(new Error('注册安全校验已取消。'),{name:'AbortError'});
const message=(data,fallback)=>typeof data?.error?.message==='string'?data.error.message.slice(0,300):fallback;
export class RegistrationClient{
 constructor({fetcher=fetch,workerFactory=()=>new Worker('/registration-proof-worker.js',{type:'module'}),now=Date.now,workerTimeoutMs=45000,requestTimeoutMs=15000}={}){Object.assign(this,{fetcher:fetcher.bind(globalThis),workerFactory,now,workerTimeoutMs,requestTimeoutMs});this.current=null;}
 cancel(){if(this.current)this.current.controller.abort();}
 active(operation){if(operation.controller.signal.aborted||this.current!==operation)throw cancelled();}
 async post(path,body,operation){
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;operation.controller.abort();},this.requestTimeoutMs);
  try{
   const response=await this.fetcher(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:operation.controller.signal});
   this.active(operation);const data=await response.json();this.active(operation);
   if(!response.ok)throw new Error(message(data,'注册暂时无法完成，请重试。'));
   return data;
  }catch(error){if(timedOut)throw new Error('注册连接超时，请检查网络后重试。');if(operation.controller.signal.aborted)throw cancelled();throw error;}
  finally{clearTimeout(timer);}
 }
 async solve(challenge,operation){
  this.active(operation);let worker;
  try{worker=this.workerFactory();}catch{throw new Error('安全校验暂不可用，请使用最新版浏览器后重试。');}
  operation.worker=worker;
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);operation.controller.signal.removeEventListener('abort',abort);worker.onmessage=null;worker.onerror=null;worker.terminate();operation.worker=null;error?reject(error):resolve(value);};
   const abort=()=>finish(cancelled()),timer=setTimeout(()=>finish(new Error('安全校验超时，请重试注册。')),this.workerTimeoutMs);
   operation.controller.signal.addEventListener('abort',abort,{once:true});
   worker.onmessage=event=>{const data=event.data;if(Number.isSafeInteger(data?.solution)&&data.solution>=0&&data.solution<=0xffffffff)finish(null,data.solution);else finish(new Error(typeof data?.error==='string'?data.error:'安全校验未完成，请重试注册。'));};
   worker.onerror=event=>{event.preventDefault?.();finish(new Error('安全校验暂时失败，请重试注册。'));};
   try{this.active(operation);worker.postMessage({challengeId:challenge.challengeId,nonce:challenge.nonce,difficulty:challenge.difficulty});}catch(error){finish(error);}
  });
 }
 async wait(ms,operation){
  this.active(operation);if(ms<=0)return;
  await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(cancelled());},timer=setTimeout(()=>{operation.controller.signal.removeEventListener('abort',abort);resolve();},ms);operation.controller.signal.addEventListener('abort',abort,{once:true});});
 }
 async register({username,password,website='',onProgress=()=>{}}){
  this.cancel();const operation={controller:new AbortController(),worker:null};this.current=operation;
  try{
   onProgress('checking');
   const challenge=await this.post('/api/account/register/challenge',{username,website},operation),receivedAt=this.now();
   if(typeof challenge.challengeId!=='string'||typeof challenge.nonce!=='string'||!Number.isInteger(challenge.difficulty)||challenge.difficulty<1||challenge.difficulty>24||!Number.isSafeInteger(challenge.expiresAt)||!Number.isSafeInteger(challenge.minWaitMs)||challenge.minWaitMs<0||challenge.minWaitMs>10000)throw new Error('安全校验信息无效，请重试注册。');
   if(this.now()>=challenge.expiresAt)throw new Error('安全校验已过期，请重新注册。');
   const solution=await this.solve(challenge,operation);
   await this.wait(Math.max(0,challenge.minWaitMs-(this.now()-receivedAt)),operation);this.active(operation);
   if(this.now()>=challenge.expiresAt)throw new Error('安全校验已过期，请重新注册。');
   onProgress('submitting');
   return await this.post('/api/account/register/password',{username,password,website,registration:{challengeId:challenge.challengeId,solution}},operation);
  }finally{operation.worker?.terminate();if(this.current===operation)this.current=null;}
 }
}

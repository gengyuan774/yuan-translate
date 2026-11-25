// Account requests must leave the UI retryable even if a connection stalls or
// an intermediary returns an HTML error page instead of the API's JSON.
export async function accountRequest(path,{body,signal,timeoutMs=15000,fetcher=fetch}={}){
 const controller=new AbortController();let timedOut=false;
 const abort=()=>controller.abort();
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
 try{
  const response=await fetcher.call(globalThis,path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
  let data;try{data=await response.json();}catch(error){if(controller.signal.aborted)throw error;throw new Error('账户服务返回异常，请稍后重试。');}
  if(!response.ok){const error=new Error(typeof data?.error?.message==='string'?data.error.message.slice(0,300):'账户服务暂不可用，请稍后重试。');error.status=response.status;throw error;}
  return data;
 }catch(error){
  if(timedOut)throw new Error('连接超时，请检查网络后重试。如果刚才提交过注册，可先尝试登录。');
  if(signal?.aborted)throw Object.assign(new Error('操作已取消。'),{name:'AbortError'});
  if(error instanceof TypeError)throw new Error('无法连接账户服务，请检查网络后重试。');
  throw error;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

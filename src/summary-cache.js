import {accountId,getSummaryMemo,saveSummaryMemo} from './storage.js';
import {TEXT_MODEL} from './models.js';
const inFlight=new Map();
export function cachedSummaryGenerator(session,generate){
 const owner=accountId(),id=session.id;
 const sameAccount=()=>{if(accountId()!==owner)throw new Error('登录账户已变化，请重新打开课堂后生成总结。');};
 return async(key,instructions,input,options={})=>{
  sameAccount();
  // Hash the complete effective request, including prompt, major and model.
  // Keep only completed output locally; never persist API keys or raw prompts.
  const payload=JSON.stringify({version:1,model:TEXT_MODEL,instructions,input,maxTokens:options.maxTokens??4000});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const saved=id?await getSummaryMemo(owner,id,hash).catch(()=>null):null;
  sameAccount();if(saved!==null)return saved;
  const scope=JSON.stringify([owner,id,hash]);
  if(id&&inFlight.has(scope))return inFlight.get(scope);
  const job=(async()=>{
   const text=await generate(key,instructions,input,options);sameAccount();
   if(typeof text!=='string'||!text.trim())throw new Error('未返回完整的总结，请重试。');
   if(id)await saveSummaryMemo(owner,id,hash,text).catch(()=>{});
   return text;
  })();
  if(id)inFlight.set(scope,job);
  try{return await job;}finally{if(inFlight.get(scope)===job)inFlight.delete(scope);}
 };
}

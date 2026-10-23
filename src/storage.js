import {validTranslationMode} from './models.js';
import {normalizeMajor} from './majors.js';
let account=null;
const connections=new Map(),queues=new Map(),syncJobs=new Map(),retryTimers=new Map(),materialCache=new Map();
const storageKey=(owner,id)=>JSON.stringify([owner,id]);
function invalidateMaterials(owner,id){for(const key of materialCache.keys()){const [who,course]=JSON.parse(key);if(who===owner&&(!id||course===id))materialCache.delete(key);}}
const namespace=owner=>owner?'classroom-notes-account-'+owner:'classroom-notes';
function database(owner,kind=''){const separate=kind==='preferences'||kind==='summary-cache',name=namespace(owner)+(separate?'-'+kind:'');if(!connections.has(name))connections.set(name,new Promise((resolve,reject)=>{const req=indexedDB.open(name,separate?1:2);req.onupgradeneeded=()=>{for(const [store,keyPath] of (separate?[[kind,'id']]:[['sessions','id'],['materials','key'],['sync','id']]))if(!req.result.objectStoreNames.contains(store))req.result.createObjectStore(store,{keyPath});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>{connections.delete(name);reject(new Error('无法打开浏览器存储，请检查隐私模式或存储权限'));};}));return connections.get(name);}
async function transaction(owner,store,mode,operation){const db=await database(owner,store);return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),request=operation(tx.objectStore(store));let result;request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(new Error('浏览器保存失败，存储空间可能不足，请先导出笔记'));tx.onabort=()=>reject(new Error('浏览器保存失败，请重试'));});}
const cached=(owner,store,id)=>transaction(owner,store,'readonly',s=>s.get(id));
const put=(owner,store,value)=>transaction(owner,store,'readwrite',s=>s.put(structuredClone(value)));
export function setAccount(user){account=user?.id||null;materialCache.clear();}
export function accountId(){return account;}
export async function getTranslationModePreference(){const value=(await cached(account,'preferences','translation-mode'))?.value;return validTranslationMode(value)?value:'accurate';}
export async function saveTranslationModePreference(value){if(!validTranslationMode(value))throw new Error('请选择支持的翻译模式');await put(account,'preferences',{id:'translation-mode',value});return value;}
export async function getMajorPreference(){return normalizeMajor((await cached(account,'preferences','major'))?.value);}
export async function saveMajorPreference(value){const major=normalizeMajor(value);await put(account,'preferences',{id:'major',value:major});return major;}
export async function setSessionPinned(id,pinned){await getSession(id);await put(account,'preferences',{id:'pin:'+id,pinned:pinned===true});}
export async function getSummaryMemo(owner,id,hash){
 const record=await cached(owner,'summary-cache',id);
 const found=record?.entries?.find(entry=>entry.hash===hash);
 return typeof found?.text==='string'&&found.text.trim()?found.text:null;
}
export function saveSummaryMemo(owner,id,hash,text){return serial(owner,id,async()=>{
 // A deleted classroom must not be recreated by a late generation result.
 if(!await cached(owner,'sessions',id)||text.length>64000)return;
 const previous=await cached(owner,'summary-cache',id),entries=(previous?.entries||[]).filter(entry=>entry.hash!==hash);
 entries.push({hash,text});let size=entries.reduce((n,entry)=>n+entry.text.length,0);
 while(entries.length>128||size>256000)size-=entries.shift().text.length;
 await put(owner,'summary-cache',{id,entries});
});}
export async function deleteSession(id){const owner=account;await stopSync(owner,id);invalidateMaterials(owner,id);return serial(owner,id,async()=>{
 if(owner)await cloud(owner,'/'+id,{method:'DELETE'});
 const db=await database(owner);
 await new Promise((resolve,reject)=>{
  const tx=db.transaction(['sessions','materials','sync'],'readwrite');
  tx.objectStore('sessions').delete(id);tx.objectStore('sync').delete(id);
  const cursor=tx.objectStore('materials').openCursor();cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(String(row.key).startsWith(id+':'))row.delete();row.continue();};
  tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('删除失败，请重试'));tx.onabort=()=>reject(new Error('删除失败，请重试'));
 });
 await transaction(owner,'preferences','readwrite',store=>store.delete('pin:'+id));
 await transaction(owner,'summary-cache','readwrite',store=>store.delete(id));
 return {ok:true};
});}
export function storageDescription(){return account?'先保存在本机，定时同步到账户':'课堂记录保存在当前浏览器';}
function report(message){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('history-save-warning',{detail:message}));}
async function cloud(owner,path,{method='GET',body}={}){const response=await fetch('/api/history'+path,{method,credentials:'same-origin',headers:{'X-Account-ID':owner,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});const data=await response.json();if(!response.ok){const error=new Error(data.error?.message||'账户历史记录暂不可用');error.status=response.status;throw error;}return data;}
function serial(owner,id,operation){const key=owner+':'+id;const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(operation);queues.set(key,next);next.finally(()=>{if(queues.get(key)===next)queues.delete(key);}).catch(()=>{});return next;}
function syncEvent(owner,id,pending){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('history-sync',{detail:{owner,id,pending}}));}
function scheduleRetry(owner,id,delay=5000){
 const key=storageKey(owner,id);if(retryTimers.has(key))return;
 const timer=setTimeout(()=>{retryTimers.delete(key);if(account===owner)syncSession(owner,id).catch(()=>{});},delay);
 timer.unref?.();retryTimers.set(key,timer);
}
async function stopSync(owner,id){const key=storageKey(owner,id);clearTimeout(retryTimers.get(key));retryTimers.delete(key);await syncJobs.get(key)?.catch(()=>{});clearTimeout(retryTimers.get(key));retryTimers.delete(key);}
// Local writes never wait for the network. Only one cloud write per classroom is
// active; live snapshots wait for the next batch, with the returned revision.
function syncSession(owner,id){
 const key=storageKey(owner,id);if(syncJobs.has(key))return syncJobs.get(key);
 clearTimeout(retryTimers.get(key));retryTimers.delete(key);
 const job=(async()=>{
  while(true){
   const current=await serial(owner,id,async()=>({state:await cached(owner,'sync',id),snapshot:await cached(owner,'sessions',id)}));
   if(!current.state?.pending)return;
   const result=await cloud(owner,'/'+id,{method:'PUT',body:{session:current.snapshot,revision:current.state.revision}});
   const deferred=await serial(owner,id,async()=>{
    const latest=await cached(owner,'sync',id);
    const pending=latest.version!==current.state.version;
    await put(owner,'sync',{...latest,revision:result.revision,pending});syncEvent(owner,id,pending);
    return pending&&latest.deferCloud;
   });
   if(deferred){scheduleRetry(owner,id,30000);return;}
  }
 })().catch(error=>{
  if(account===owner)report('记录已暂存在此设备，账户同步未完成：'+error.message);
  // Do not automatically retry identity failures or overwrite a conflicting tab.
  if(!error.status||error.status>=500||error.status===429)scheduleRetry(owner,id);
  throw error;
 }).finally(()=>{if(syncJobs.get(key)===job)syncJobs.delete(key);});
 syncJobs.set(key,job);return job;
}
export async function saveSession(s,{background=false,deferCloud=false,owner=account}={}){
 const snapshot=structuredClone(s);
 await serial(owner,s.id,async()=>{
  await put(owner,'sessions',snapshot);if(!owner)return;
  const state=await cached(owner,'sync',s.id)||{id:s.id,revision:0};
  await put(owner,'sync',{...state,pending:true,deferCloud:background&&deferCloud,version:(state.version||0)+1});syncEvent(owner,s.id,true);
 });
 if(owner){if(background&&deferCloud){if(!syncJobs.has(storageKey(owner,s.id)))scheduleRetry(owner,s.id,30000);return;}const job=syncSession(owner,s.id);if(background){job.catch(()=>{});}else await job;}
}
export async function sessionSyncPending(id){return !!(await cached(account,'sync',id))?.pending;}
export async function getSession(id){const owner=account;invalidateMaterials(owner,id);
 if(owner){const pending=await cached(owner,'sync',id);if(pending?.pending){report('这节课有尚未同步到账户的内容，已打开此设备的副本。');const local=await cached(owner,'sessions',id);if(local)return local;}
 const result=await cloud(owner,'/'+id);await put(owner,'sessions',result.session);await put(owner,'sync',{id,revision:result.revision,pending:false});return result.session;}
 const s=await cached(owner,'sessions',id);if(!s)throw new Error('当前浏览器中没有这节课');return s;
}
const metadata=({id,title,createdAt,status,segments,demo})=>({id,title,createdAt,status,count:segments.length,demo});
export async function listSessions(){const owner=account;
 const pins=new Set((await transaction(owner,'preferences','readonly',store=>store.getAll())).filter(x=>x.id.startsWith('pin:')&&x.pinned).map(x=>x.id.slice(4)));
 const sorted=items=>items.map(s=>({...s,pinned:pins.has(s.id)})).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.createdAt.localeCompare(a.createdAt));
 const local=(await transaction(owner,'sessions','readonly',store=>store.getAll())).map(metadata);
 if(!owner)return sorted(local);
 const states=(await transaction(owner,'sync','readonly',store=>store.getAll())).filter(s=>s.pending);
 // Reopening the page restores uploads left pending in durable local storage.
 for(const state of states)if(state.deferCloud&&account===owner&&!syncJobs.has(storageKey(owner,state.id)))scheduleRetry(owner,state.id,30000);
 const remote=await cloud(owner,'');const pending=(await transaction(owner,'sync','readonly',store=>store.getAll())).filter(s=>s.pending).map(s=>s.id);
 return sorted([...remote.filter(s=>!pending.includes(s.id)),...local.filter(s=>pending.includes(s.id))]);
}
export async function saveMaterial(sessionId,m){const owner=account;invalidateMaterials(owner,sessionId);await put(owner,'materials',{...m,key:sessionId+':'+m.id});if(owner)await cloud(owner,'/'+sessionId+'/materials/'+m.id,{method:'PUT',body:m});}
export async function getMaterial(sessionId,id){
 const owner=account,key=JSON.stringify([owner,sessionId,id]);
 if(!materialCache.has(key)){
  const job=(async()=>{if(owner){const result=await cloud(owner,'/'+sessionId+'/materials/'+id);await put(owner,'materials',{...result,key:sessionId+':'+id});return result;}const m=await cached(owner,'materials',sessionId+':'+id);if(!m)throw new Error('当前课堂的资料不存在');return m;})();
  materialCache.set(key,job);job.catch(()=>{if(materialCache.get(key)===job)materialCache.delete(key);});
  if(materialCache.size>30)materialCache.delete(materialCache.keys().next().value);
 }
 return structuredClone(await materialCache.get(key));
}
export async function removeMaterial(sessionId,id){const owner=account;invalidateMaterials(owner,sessionId);if(owner)await cloud(owner,'/'+sessionId+'/materials/'+id,{method:'DELETE'});return transaction(owner,'materials','readwrite',store=>store.delete(sessionId+':'+id));}

export async function exportLocalAccount(owner=account){
 const result={};for(const store of ['sessions','materials','preferences'])result[store]=await transaction(owner,store,'readonly',s=>s.getAll());return result;
}
export async function clearLocalAccount(owner=account){
 invalidateMaterials(owner);
 for(const key of new Set([...syncJobs.keys(),...retryTimers.keys()])){const [who,id]=JSON.parse(key);if(who===owner)await stopSync(owner,id);}
 for(const [key,promise] of queues)if(key.startsWith(owner+':'))await promise.catch(()=>{});
 for(const store of ['sessions','materials','sync','preferences','summary-cache'])await transaction(owner,store,'readwrite',s=>s.clear());
}

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserLive} from '../src/live.js';
import {setAccount,saveSession,getSession,listSessions,sessionSyncPending,clearLocalAccount,deleteSession} from '../src/storage.js';
const lesson=id=>({id,title:'课堂',createdAt:new Date().toISOString(),segments:[],materials:[],warnings:[],status:'recording',summary:''});
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
function batchClock(t){
 const timers=new Map(),nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms!==30000)return nativeSet(fn,ms,...args);const id={unref(){}};timers.set(id,fn);return id;});
 t.mock.method(globalThis,'clearTimeout',id=>{if(!timers.delete(id))nativeClear(id);});
 return {timers,fire(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}};
}
for(const status of [503,409])test('reopening a completed classroom '+(status===503?'resumes a temporary upload failure':'keeps a version conflict paused'),async t=>{
 const owner=crypto.randomUUID(),id=crypto.randomUUID();setAccount({id:owner});
 const timers=new Set(),nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms!==5000&&ms!==30000)return nativeSet(fn,ms,...args);const item={fn,unref(){}};timers.add(item);return item;});
 t.mock.method(globalThis,'clearTimeout',id=>{if(!timers.delete(id))nativeClear(id);});
 let online=false,writes=0;
 t.mock.method(globalThis,'fetch',async(_path,{method})=>{
  if(method==='GET')return Response.json([]);
  writes++;return online?Response.json({revision:1}):Response.json({error:{message:'延迟保存'}},{status});
 });
 const reopened=await import('../src/storage.js?tab='+id);
 try{
  await assert.rejects(saveSession({...lesson(id),status:'completed'}));setAccount(null);timers.clear();online=true;
  reopened.setAccount({id:owner});assert.equal((await reopened.listSessions())[0].id,id);
  assert.equal(timers.size,status===503?1:0);
  if(status===503){[...timers][0].fn();await until(async()=>!await reopened.sessionSyncPending(id));assert.equal(writes,2);}
  else assert.equal(writes,1);
 }finally{await clearLocalAccount(owner);await reopened.clearLocalAccount(owner);reopened.setAccount(null);setAccount(null);}
});
test('live saves are local immediately and batch the latest snapshot without continuous upload; pause flushes',async t=>{
 const clock=batchClock(t),writes=[];let release;
 setAccount({id:'batch-live'});
 t.mock.method(globalThis,'fetch',async(path,init)=>{const body=JSON.parse(init.body);writes.push(body);if(writes.length===1)await new Promise(r=>release=r);return Response.json({revision:body.revision+1});});
 const live=new BrowserLive();live.session=lesson('batch-class');
 try{
  await live.persist();const timer=[...clock.timers.keys()][0];
  for(let i=0;i<10;i++){live.session.summary='snapshot '+i;await live.persist();}
  assert.equal(writes.length,0);assert.equal(clock.timers.size,1);assert.equal([...clock.timers.keys()][0],timer);
  assert.equal((await getSession(live.session.id)).summary,'snapshot 9');
  clock.fire();await until(()=>release);assert.equal(writes[0].session.summary,'snapshot 9');
  live.session.summary='arrived during upload';await live.persist();release();
  await until(()=>clock.timers.size===1);assert.equal(writes.length,1);assert.equal(await sessionSyncPending(live.session.id),true);
  clock.fire();await until(async()=>!await sessionSyncPending(live.session.id));
  assert.equal(writes.length,2);assert.equal(writes[1].revision,1);assert.equal(writes[1].session.summary,'arrived during upload');
  live.session.summary='last sentence';await live.persist();assert.equal(clock.timers.size,1);
  await live.command({type:'pause'});await until(async()=>!await sessionSyncPending(live.session.id));
  assert.equal(clock.timers.size,0);assert.equal(writes.length,3);assert.equal(writes[2].session.status,'paused');assert.equal(writes[2].session.summary,'last sentence');
 }finally{release?.();live.finalizing=true;live.close();await clearLocalAccount();setAccount(null);}
});
test('account changes stop delayed uploads; reopening restores pending batches; deletion cancels them',async t=>{
 const clock=batchClock(t),writes=[];setAccount({id:'batch-owner'});
 t.mock.method(globalThis,'fetch',async(path,init)=>{if(init.method==='GET')return Response.json([]);writes.push({path,method:init.method});return Response.json({revision:1});});
 try{
  const s=lesson('recover');await saveSession(s,{background:true,deferCloud:true});
  setAccount({id:'other-owner'});clock.fire();assert.equal(writes.length,0);
  setAccount({id:'batch-owner'});assert.equal((await listSessions())[0].id,s.id);assert.equal(clock.timers.size,1);
  clock.fire();await until(async()=>!await sessionSyncPending(s.id));assert.equal(writes.length,1);
  await saveSession(lesson('delete'),{background:true,deferCloud:true});await deleteSession('delete');assert.equal(clock.timers.size,0);
  assert.deepEqual(writes.map(w=>w.method),['PUT','DELETE']);
 }finally{await clearLocalAccount();setAccount(null);}
});

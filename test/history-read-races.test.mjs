import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setAccount,saveSession,getSession,listSessions,deleteSession,sessionSyncPending,clearLocalAccount} from '../src/storage.js';

function fixture(t){
 const owner=crypto.randomUUID(),id=crypto.randomUUID(),date=new Date().toISOString();
 const initial={id,title:'同一节课',createdAt:date,status:'paused',segments:[],materials:[]};
 const updated={...initial,segments:[{id:'last',source:'The last sentence.',translation:'最后一句。'}]};
 const entered=Promise.withResolvers(),reply=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async(path,{method,body})=>{
  if(method==='PUT')return Response.json({revision:JSON.parse(body).revision+1});
  if(method==='DELETE')return Response.json({ok:true});
  entered.resolve(path);return Response.json(await reply.promise);
 });
 setAccount({id:owner});
 t.after(async()=>{await clearLocalAccount(owner);setAccount(null);});
 return {id,initial,updated,entered:entered.promise,reply:reply.resolve};
}

for(const deferred of [true,false])test('older cloud read cannot replace a newer '+(deferred?'pending':'synchronized')+' subtitle',async t=>{
 const f=fixture(t);await saveSession(f.initial);const reading=getSession(f.id);await f.entered;
 await saveSession(f.updated,{background:deferred,deferCloud:deferred});f.reply({session:f.initial,revision:1});
 assert.deepEqual((await reading).segments,f.updated.segments);assert.equal(await sessionSyncPending(f.id),deferred);
});
test('a delayed history list includes a subtitle written while loading',async t=>{
 const f=fixture(t);await saveSession(f.initial);const listing=listSessions();await f.entered;
 await saveSession(f.updated,{background:true,deferCloud:true});f.reply([{...f.initial,count:0,revision:1}]);
 assert.equal((await listing)[0].count,1);
});
test('two tabs reading revisions in reverse network order both finish with the newest one',async t=>{
 const id=crypto.randomUUID(),owner=crypto.randomUUID(),entered=Promise.withResolvers(),first=Promise.withResolvers();
 const secondTab=await import('../src/storage.js?tab='+id);setAccount({id:owner});secondTab.setAccount({id:owner});
 t.after(async()=>{await clearLocalAccount(owner);setAccount(null);secondTab.setAccount(null);});
 const lesson={id,title:'课堂',status:'completed',createdAt:new Date().toISOString(),segments:[]};
 let reads=0;t.mock.method(globalThis,'fetch',async()=>{
  if(++reads===1){entered.resolve();await first.promise;return Response.json({session:lesson,revision:4});}
  return Response.json({session:{...lesson,title:'新标题'},revision:5});
 });
 const old=getSession(id);await entered.promise;assert.equal((await secondTab.getSession(id)).title,'新标题');
 first.resolve();assert.equal((await old).title,'新标题');
});
test('a late cloud read cannot recreate a deleted classroom',async t=>{
 const f=fixture(t);await saveSession(f.initial);const reading=getSession(f.id);await f.entered;
 await deleteSession(f.id);f.reply({session:f.initial,revision:1});
 await assert.rejects(reading,e=>e.status===404);
});
test('a gateway login response retains its HTTP status even with an empty body',async t=>{
 const owner=crypto.randomUUID(),id=crypto.randomUUID();
 setAccount({id:owner});t.after(async()=>{await clearLocalAccount(owner);setAccount(null);});
 t.mock.method(globalThis,'fetch',async(_path,{method})=>method==='PUT'?Response.json({revision:1}):new Response(null,{status:401}));
 await saveSession({id,title:'已保存',status:'paused',createdAt:new Date().toISOString(),segments:[]});
 await assert.rejects(getSession(id),e=>e.status===401);await assert.rejects(listSessions(),e=>e.status===401);
});

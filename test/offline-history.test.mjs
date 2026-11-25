import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setAccount,saveSession,saveMaterial,getSession,getMaterial,listSessions,clearLocalAccount} from '../src/storage.js';
test('a network outage preserves access to this account’s cached classrooms and reference files',async t=>{
 const id=crypto.randomUUID(),mid=crypto.randomUUID(),owner=crypto.randomUUID();
 const lesson={id,title:'断网保留测试',createdAt:new Date().toISOString(),status:'completed',segments:[{source:'A saved sentence',translation:'已保存的句子'}],summary:'已保存笔记',materials:[]};
 const material={id:mid,name:'lecture.txt',pages:[{label:'第 1 页',text:'CPI is the Consumer Price Index.'}]};
 let offline=false,status=0;
 t.mock.method(globalThis,'fetch',async(path,init)=>{
  if(offline){if(status)return Response.json({error:{message:'Unavailable'}},{status});throw new TypeError('Failed to fetch');}
  if(init.method==='PUT')return Response.json({revision:1});
  if(path.endsWith('/materials/'+mid))return Response.json(material);
  if(path.endsWith('/'+id))return Response.json({session:lesson,revision:1});
  return Response.json([{id,title:lesson.title,createdAt:lesson.createdAt,status:lesson.status,count:1}]);
 });
 setAccount({id:owner});
 try{
  await saveSession(lesson);await saveMaterial(id,material);offline=true;
  for(const failure of [0,503,429]){status=failure;setAccount({id:owner});assert.equal((await listSessions())[0].id,id);assert.deepEqual(await getSession(id),lesson);assert.equal((await getMaterial(id,mid)).pages[0].text,material.pages[0].text);}
  for(const failure of [401,403,404,409]){status=failure;setAccount({id:owner});await assert.rejects(listSessions,error=>error.status===failure);await assert.rejects(getSession(id),error=>error.status===failure);await assert.rejects(getMaterial(id,mid),error=>error.status===failure);}
  status=0;setAccount({id:'different-account'});assert.deepEqual(await listSessions(),[]);await assert.rejects(getSession(id));await assert.rejects(getMaterial(id,mid));
  setAccount({id:owner});offline=false;assert.deepEqual(await getSession(id),lesson);
 }finally{setAccount({id:owner});await clearLocalAccount();setAccount(null);}
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handle} from '../src/worker.js';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {setAccount,saveSession,getSession,listSessions,saveMaterial,getMaterial,setSessionPinned,deleteSession} from '../src/storage.js';
function runtime(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={prepare(query){return {bind(...args){const st=sql.prepare(query);return {async first(){return st.get(...args)||null;},async all(){return {results:st.all(...args)};},async run(){return st.run(...args);}};}};},async batch(items){for(const item of items)await item.run();}};
 const objects=new Map(),BUCKET={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{async json(){return JSON.parse(objects.get(key));}}:null;},async delete(key){objects.delete(key);}};
 return {sql,objects,env:{DB,BUCKET,TRIAL_CLAIM_SECRET:'synthetic-history-trial-claim-secret-only'}};
}
const session=(id=crypto.randomUUID())=>({id,title:'测试课堂',translationMode:'fast',sourceLanguage:'ja',major:{code:'medicine',custom:''},createdAt:new Date().toISOString(),status:'completed',segments:[{id:'s1',offset:0,source:'English',translation:'中文'}],materials:[],warnings:[],summary:'课堂总结'});
const user=(env,subject)=>createVerifiedAccountSession(env,{provider:'email',subject,label:subject});
function request(path,who,method='GET',body,extra={}){return new Request('https://example.test'+path,{method,headers:{Cookie:who?.cookie.split(';')[0]||'',Origin:'https://example.test','Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});}
const noProvider=()=>{throw new Error('No external provider may be called');};
test('login stays unavailable and forged client identity cannot read history',async()=>{
 const {env}=runtime();assert.deepEqual(await (await handle(request('/api/account'),noProvider,env)).json(),{user:null,methods:{password:true,phone:false,email:false,wechat:false}});
 for(const kind of ['phone','email','wechat'])assert.equal((await handle(request('/api/account/login/'+kind,null,'POST',{}),noProvider,env)).status,503);
 assert.equal((await handle(request('/api/history',null,'GET',undefined,{'X-Account-ID':'fake','oai-authenticated-user-id':'fake'}),noProvider,env)).status,401);
});
test('account records and materials persist across sessions with ownership enforced',async()=>{
 const {env}=runtime(),a=await user(env,'a@example.test'),b=await user(env,'b@example.test'),s=session();
 const call=(path,who,method,body)=>handle(request(path,who,method,body),noProvider,env);
 assert.equal((await call('/api/history/'+s.id,a,'PUT',{session:s,revision:0})).status,200);
 const again=await user(env,'a@example.test');assert.equal(again.user.id,a.user.id);
 const saved=await (await call('/api/history/'+s.id,again)).json();assert.deepEqual(saved.session,s);assert.equal(saved.revision,1);
 assert.equal((await call('/api/history/'+s.id,b)).status,404);assert.equal((await (await call('/api/history',b)).json()).length,0);
 const mid=crypto.randomUUID(),m={id:mid,name:'lecture.txt',pages:[{label:'第 1 段',text:'参考资料'}],warnings:[],pageCount:1,characters:4};
 assert.equal((await call('/api/history/'+s.id+'/materials/'+mid,a,'PUT',m)).status,200);
 assert.deepEqual(await (await call('/api/history/'+s.id+'/materials/'+mid,again)).json(),m);
 assert.equal((await call('/api/history/'+s.id+'/materials/'+mid,b,'DELETE')).status,404);
 const stale=await call('/api/history/'+s.id,a,'PUT',{session:{...s,title:'过期副本'},revision:0});assert.equal(stale.status,409);
 assert.equal((await (await call('/api/history/'+s.id,a)).json()).session.title,s.title);
 assert.equal((await handle(request('/api/history',a,'GET',undefined,{'X-Account-ID':b.user.id}),noProvider,env)).status,409);
 await call('/api/account/logout',a,'POST',{});assert.equal((await call('/api/history',a)).status,401);
});
test('failed object writes do not replace the saved record',async()=>{
 const {env}=runtime(),a=await user(env,'failure@example.test'),s=session();
 await handle(request('/api/history/'+s.id,a,'PUT',{session:s,revision:0}),noProvider,env);
 env.BUCKET.put=async()=>{throw new Error('unavailable');};
 assert.equal((await handle(request('/api/history/'+s.id,a,'PUT',{session:{...s,title:'unsaved'},revision:1}),noProvider,env)).status,503);
 assert.equal((await (await handle(request('/api/history/'+s.id,a),noProvider,env)).json()).session.title,s.title);
});
test('existing guest database upgrades without losing classroom records',async()=>{
 const s=session();await new Promise((resolve,reject)=>{const open=indexedDB.open('classroom-notes',1);open.onupgradeneeded=()=>{open.result.createObjectStore('sessions',{keyPath:'id'});open.result.createObjectStore('materials',{keyPath:'key'});};open.onsuccess=()=>{const db=open.result,tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(s);tx.oncomplete=()=>{db.close();resolve();};};open.onerror=reject;});
 setAccount(null);assert.deepEqual(await getSession(s.id),s);assert.equal((await listSessions()).length,1);
});
test('browser storage switches accounts without mixing guest or account records',async()=>{
 const {env}=runtime(),a=await user(env,'browser-a@example.test'),b=await user(env,'browser-b@example.test');let active=a;const original=globalThis.fetch;
 globalThis.fetch=(path,options={})=>handle(new Request('https://example.test'+path,{...options,headers:{...options.headers,Cookie:active.cookie.split(';')[0],Origin:'https://example.test'}}),noProvider,env);
 try{
  setAccount(a.user);const s=session();await saveSession(s);s.summary='更新后的总结';await saveSession(s);assert.equal((await getSession(s.id)).summary,s.summary);
  const mid=crypto.randomUUID(),m={id:mid,name:'notes.txt',pages:[{label:'第 1 段',text:'資料'}]};await saveMaterial(s.id,m);assert.equal((await getMaterial(s.id,mid)).name,'notes.txt');
  active=b;setAccount(b.user);assert.equal((await listSessions()).length,0);await assert.rejects(()=>getSession(s.id),/不存在/);
  active=a;setAccount(a.user);assert.equal((await listSessions())[0].id,s.id);
  setAccount(null);assert.equal((await listSessions()).some(x=>x.id===s.id),false);
 }finally{globalThis.fetch=original;setAccount(null);}
});
test('pinning survives subsequent saves; deleting a class removes only its own local data',async()=>{
 setAccount(null);const older=session(),newer=session();older.createdAt='2025-01-01T00:00:00Z';newer.createdAt='2026-01-01T00:00:00Z';
 await saveSession(older);await saveSession(newer);await setSessionPinned(older.id,true);
 older.summary='继续保存字幕';await saveSession(older);
 assert.equal((await listSessions())[0].id,older.id);
 await setSessionPinned(older.id,false);assert.ok((await listSessions()).findIndex(s=>s.id===newer.id)<(await listSessions()).findIndex(s=>s.id===older.id));
 await setSessionPinned(older.id,true);
 const mid=crypto.randomUUID();await saveMaterial(older.id,{id:mid,name:'a.txt'});await saveMaterial(newer.id,{id:mid,name:'b.txt'});
 await deleteSession(older.id);assert.equal((await listSessions()).some(s=>s.id===older.id),false);
 await assert.rejects(()=>getSession(older.id));await assert.rejects(()=>getMaterial(older.id,mid));
 assert.equal((await getMaterial(newer.id,mid)).name,'b.txt');
 await saveSession(older);assert.equal((await listSessions()).find(s=>s.id===older.id).pinned,false);
});
test('account deletion enforces ownership and removes class plus material objects',async()=>{
 const {env,objects}=runtime(),a=await user(env,'delete-a@example.test'),b=await user(env,'delete-b@example.test'),s=session();
 const call=(path,who,method,body)=>handle(request(path,who,method,body),noProvider,env);
 await call('/api/history/'+s.id,a,'PUT',{session:s,revision:0});
 const mid=crypto.randomUUID();await call('/api/history/'+s.id+'/materials/'+mid,a,'PUT',{id:mid,name:'a.txt',pages:[{label:'1',text:'资料'}]});
 assert.equal(objects.size,2);assert.equal((await call('/api/history/'+s.id,b,'DELETE')).status,404);assert.equal(objects.size,2);
 assert.equal((await call('/api/history/'+s.id,a,'DELETE')).status,200);assert.equal(objects.size,0);
 assert.equal((await call('/api/history/'+s.id,a)).status,404);assert.equal((await (await call('/api/history',a)).json()).length,0);
});


test('uploaded PPT survives live translation, trial, summary and cloud reopen',async()=>{
 const {localApi}=await import('../src/local-api.js');
 const {BrowserLive}=await import('../src/live.js');
 const {activateClientMembership}=await import('./access-fixture.mjs');
 const {extractMaterial}=await import('../src/material-parser.js');
 const {zipSync,strToU8}=await import('fflate');
 await activateClientMembership();
 const {env}=runtime(),a=await user(env,'ppt-regression@example.test');
 const originalFetch=globalThis.fetch,originalWorker=globalThis.Worker,inputs=[];
 globalThis.Worker=class {terminate(){} postMessage({buffer,name}){extractMaterial(Buffer.from(buffer),name).then(result=>this.onmessage({data:{result}}));}};
 globalThis.fetch=(path,options={})=>{
  if(path==='/api/openai/responses'){inputs.push(JSON.parse(options.body).input);return Promise.resolve(Response.json({output:[{content:[{type:'output_text',text:'机会成本：最佳替代方案的价值。'}]}]}));}
  if(path==='/api/service/summary'){const data=JSON.parse(options.body);inputs.push(data.snapshot.materials.map(m=>m.pages.map(p=>p.text).join('\n')).join('\n'));return Promise.resolve(Response.json({summary:'机会成本：最佳替代方案的价值。',summarySources:data.snapshot.materials.map(m=>({id:m.id,name:m.name,pageCount:m.pages.length,warnings:m.warnings||[]})),summaryScope:'classroom'}));}
  return handle(new Request('https://example.test'+path,{...options,headers:{...options.headers,Cookie:a.cookie.split(';')[0],Origin:'https://example.test'}}),noProvider,env);
 };
 const live=new BrowserLive();live.connect=async function(){this.session.status='recording';await this.persist();};
 try{
  setAccount(a.user);
  const s=await localApi('/api/sessions',{method:'POST',body:JSON.stringify({title:'PPT regression'})});
  const bytes=zipSync({'ppt/presentation.xml':strToU8('<p:presentation><p:sldIdLst><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>'),'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>'),'ppt/slides/slide1.xml':strToU8('<p:sld><a:p><a:r><a:t>Opportunity cost: the next best alternative.</a:t></a:r></a:p></p:sld>')});
  const uploaded=await localApi('/api/sessions/'+s.id+'/materials',{method:'POST',headers:{'X-File-Name':'lecture.pptx'},body:new Blob([bytes])});
  const mid=uploaded.materials[0].id;assert.equal(uploaded.materials.length,1);
  await localApi('/api/sessions/'+s.id+'/try',{method:'POST',body:JSON.stringify({text:'Explain opportunity cost.'})});
  await live.command({type:'start',id:s.id});assert.equal(live.session.materials[0].id,mid);
  await live.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'segment',transcript:'Opportunity cost matters.'});
  await live.queue;live.closing=true;await live.finalize();
  const reopened=await getSession(s.id);assert.equal(reopened.materials[0].id,mid);assert.equal(reopened.summarySources[0].name,'lecture.pptx');
  assert.equal(reopened.segments[0].translation,'机会成本：最佳替代方案的价值。');
  assert.ok(inputs.length>=4);for(const input of inputs)assert.match(input,/next best alternative/);
  assert.match((await getMaterial(s.id,mid)).pages[0].text,/Opportunity cost/);
 }finally{live.close();globalThis.fetch=originalFetch;globalThis.Worker=originalWorker;setAccount(null);}
});

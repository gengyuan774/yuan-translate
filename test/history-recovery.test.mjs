import test from 'node:test';
import assert from 'node:assert/strict';
import {environment} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {digest} from '../src/security-common.js';
import {handle} from '../src/worker.js';
import {readCloudClass} from '../src/recovery-client.js';

const classId='2813de7e-e9f6-4097-9a2a-5bb7b5e0afc0',token='ab'.repeat(32);
async function fixture(){
 const f=environment(),objects=new Map();
 f.env.MEMBER_ADMIN_TOKEN_SHA256=await digest(token);
 f.env.BUCKET={async get(key){return objects.has(key)?{async json(){return JSON.parse(objects.get(key));}}:null;},async put(key,value){objects.set(key,value);},async delete(key){objects.delete(key);}};
 const owner=await createVerifiedAccountSession(f.env,{provider:'email',subject:'owner@example.test',label:'recoveryqa'});
 const other=await createVerifiedAccountSession(f.env,{provider:'email',subject:'other@example.test',label:'otherqa'});
 f.sql.prepare('INSERT INTO account_passwords (username,account_id,password_hash,created_at) VALUES (?,?,?,?)').run('recoveryqa',owner.user.id,'test-only',1);
 const session={id:classId,title:'课堂恢复测试',createdAt:'2026-10-12T08:10:20.825Z',status:'completed',segments:[{id:'one',source:'PRIVATE ORIGINAL',translation:'私密译文'}],summary:'私密总结',materials:[]};
 const send=(path,who=owner,method='GET',body,headers={})=>handle(new Request('https://example.test'+path,{method,headers:{Origin:'https://example.test',Cookie:who?.cookie.split(';')[0]||'','Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined}),()=>{throw new Error('No upstream allowed');},f.env);
 assert.equal((await send('/api/history/'+classId,owner,'PUT',{session,revision:0})).status,200);
 const check=(auth=token,name='recoveryqa',id=classId,method='GET')=>send(`/api/admin/history/check?username=${encodeURIComponent(name)}&classId=${encodeURIComponent(id)}`,owner,method,undefined,auth?{Authorization:'Bearer '+auth}:{});
 return {...f,objects,owner,other,session,send,check};
}
test('history diagnostics require admin credentials and never return class contents or change stored copies',async()=>{
 const f=await fixture(),before=f.sql.prepare('SELECT * FROM account_classes').get(),objects=[...f.objects];
 assert.equal((await f.check(null)).status,401);assert.equal((await f.check('cd'.repeat(32))).status,401);
 assert.equal((await f.check(token,'recoveryqa',classId,'POST')).status,404);
 const response=await f.check(),result=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(result,{classId,createdAt:f.session.createdAt,status:'completed',revision:1,indexedSegments:1,objectStatus:'readable',segments:1,sourceSegments:1,translatedSegments:1,hasSummary:true,summaryCharacters:4,endedAt:null});
 assert.deepEqual(f.sql.prepare('SELECT * FROM account_classes').get(),before);assert.deepEqual([...f.objects],objects);
 const audit=f.sql.prepare("SELECT * FROM security_audit WHERE action='history_checked'").get();assert.equal(audit.actor,'admin');assert.deepEqual(JSON.parse(audit.details),{classId,revision:1});
});
test('diagnostics distinguish absent and damaged objects; invalid or foreign class IDs cannot read objects',async()=>{
 const f=await fixture(),key=[...f.objects.keys()][0];
 f.objects.set(key,'broken json');assert.equal((await (await f.check()).json()).objectStatus,'invalid');
 f.objects.delete(key);assert.equal((await (await f.check()).json()).objectStatus,'missing');
 assert.equal((await f.check(token,'recoveryqa','../other')).status,400);
 assert.equal((await f.check(token,'recoveryqa',crypto.randomUUID())).status,404);
 const foreign=await f.send('/api/history/'+classId,f.other);assert.equal(foreign.status,404);
});
test('cloud reader fetches latest owner data directly with GET only, without reading or changing local storage',async()=>{
 const f=await fixture(),calls=[],before=[...f.objects],databaseBefore=f.sql.prepare('SELECT * FROM account_classes').get();
 const fetcher=async(path,options)=>{calls.push({path,...options});return f.send(path,f.owner,options.method,undefined,options.headers);};
 const result=await readCloudClass(classId,fetcher);assert.deepEqual(result.session,f.session);
 assert.deepEqual(calls.map(c=>c.path),['/api/account','/api/history/'+classId]);
 for(const c of calls){assert.equal(c.method,'GET');assert.equal(c.cache,'no-store');assert.equal(c.credentials,'same-origin');}
 assert.equal(calls[1].headers['X-Account-ID'],f.owner.user.id);
 assert.deepEqual([...f.objects],before);assert.deepEqual(f.sql.prepare('SELECT * FROM account_classes').get(),databaseBefore);
});
test('cloud reader requires login, rejects another account, and detects account changes between requests',async()=>{
 const f=await fixture();
 await assert.rejects(()=>readCloudClass(classId,(p,o)=>f.send(p,null,o.method,undefined,o.headers)),{status:401});
 await assert.rejects(()=>readCloudClass(classId,(p,o)=>f.send(p,f.other,o.method,undefined,o.headers)),{status:404});
 await assert.rejects(()=>readCloudClass(classId,(p,o)=>f.send(p,p==='/api/account'?f.owner:f.other,o.method,undefined,o.headers)),{status:409});
 await assert.rejects(()=>readCloudClass('invalid',()=>{throw new Error('must not fetch');}),/链接不完整/);
});

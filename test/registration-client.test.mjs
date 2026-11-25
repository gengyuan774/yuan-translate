import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RegistrationClient} from '../src/registration-client.js';
import {hasLeadingZeroBits,solveRegistrationProof} from '../src/registration-proof-worker.js';
const challenge=(id='challenge-1',minWaitMs=0)=>({challengeId:id,nonce:'server-nonce',difficulty:8,expiresAt:Date.now()+300000,minWaitMs});
const credentials={username:'trial-user',password:'Several unique words make this strong',website:''};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function workerFactory(handler){const workers=[];return {workers,create(){const worker={terminated:false,terminate(){this.terminated=true;},postMessage(data){this.input=data;handler?.(this,data);}};workers.push(worker);return worker;}};}

test('worker solution satisfies the independent SHA-256 leading-bit check and rejects unsafe parameters',async()=>{
 const data={challengeId:'test-identity',nonce:'test-nonce',difficulty:12},solution=solveRegistrationProof(data);
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.challengeId+':'+data.nonce+':'+solution)));
 assert.equal(hasLeadingZeroBits(digest,12),true);assert.equal(digest[0],0);assert.equal(digest[1]>>4,0);
 assert.throws(()=>solveRegistrationProof({...data,difficulty:30}),/参数无效/);
 let now=0;assert.throws(()=>solveRegistrationProof({...data,difficulty:24},()=>{now+=45000;return now;}),/超时/);
});

test('registration obtains a fresh same-origin challenge, waits, then submits only its own proof',async()=>{
 const calls=[],progress=[],receivedAt=Date.now(),workers=workerFactory(worker=>queueMicrotask(()=>worker.onmessage({data:{solution:42}})));
 const client=new RegistrationClient({workerFactory:()=>workers.create(),fetcher:async(path,options)=>{
  calls.push({path,options,body:JSON.parse(options.body),time:Date.now()});
  return Response.json(path.endsWith('/challenge')?challenge('bound-identity',25):{user:{id:'signed-in-account'}});
 }});
 const result=await client.register({...credentials,onProgress:state=>progress.push(state)});
 assert.equal(result.user.id,'signed-in-account');assert.deepEqual(progress,['checking','submitting']);assert.equal(calls.length,2);
 assert.equal(calls[0].path,'/api/account/register/challenge');assert.deepEqual(calls[0].body,{username:credentials.username,website:''});
 assert.equal(calls[1].path,'/api/account/register/password');assert.deepEqual(calls[1].body,{...credentials,registration:{challengeId:'bound-identity',solution:42}});
 assert.ok(calls[1].time-receivedAt>=25);assert.ok(calls.every(call=>call.options.credentials==='same-origin'&&call.options.cache==='no-store'));
 assert.equal(workers.workers[0].terminated,true);assert.equal(client.current,null);
});

test('cancelling a running proof terminates its worker and never creates the account',async()=>{
 let calls=0;const workers=workerFactory(),client=new RegistrationClient({workerFactory:()=>workers.create(),fetcher:async()=>{calls++;return Response.json(challenge());}});
 const run=client.register(credentials);await flush();assert.equal(workers.workers.length,1);client.cancel();
 await assert.rejects(run,error=>error.name==='AbortError');assert.equal(calls,1);assert.equal(workers.workers[0].terminated,true);assert.equal(client.current,null);
});

test('cancelling the minimum wait prevents registration even after a valid solution',async()=>{
 let calls=0;const workers=workerFactory(worker=>queueMicrotask(()=>worker.onmessage({data:{solution:7}})));
 const client=new RegistrationClient({workerFactory:()=>workers.create(),fetcher:async()=>{calls++;return Response.json(challenge('wait-proof',200));}});
 const run=client.register(credentials);await flush();client.cancel();await assert.rejects(run,error=>error.name==='AbortError');assert.equal(calls,1);
});

test('a timed-out worker is terminated and a retry receives a different challenge',async()=>{
 let requests=0,respond=false;const workers=workerFactory(worker=>{if(respond)queueMicrotask(()=>worker.onmessage({data:{solution:1}}));});
 const client=new RegistrationClient({workerTimeoutMs:10,workerFactory:()=>workers.create(),fetcher:async path=>{requests++;return Response.json(path.endsWith('/challenge')?challenge('attempt-'+requests):{user:{id:'recovered'}});}});
 await assert.rejects(client.register(credentials),/超时/);assert.equal(workers.workers[0].terminated,true);respond=true;
 assert.equal((await client.register(credentials)).user.id,'recovered');assert.equal(workers.workers[1].input.challengeId,'attempt-2');assert.equal(requests,3);
});

test('expired or malformed challenge responses cannot reach registration',async()=>{
 for(const invalid of [{...challenge(),expiresAt:1},{...challenge(),difficulty:99},{...challenge(),minWaitMs:-1}]){
  let calls=0;const workers=workerFactory(worker=>queueMicrotask(()=>worker.onmessage({data:{solution:3}})));
  const client=new RegistrationClient({workerFactory:()=>workers.create(),fetcher:async()=>{calls++;return Response.json(invalid);}});
  await assert.rejects(client.register(credentials),/过期|无效/);assert.equal(calls,1);
 }
});

test('registration UI exposes policy and cancellation without applying new password rules to existing logins',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8'),security=readFileSync(new URL('../src/security-ui.js',import.meta.url),'utf8'),build=readFileSync(new URL('../build.mjs',import.meta.url),'utf8');
 assert.match(html,/id="login-username"[^>]*autocapitalize="none"[^>]*autocorrect="off"/);assert.match(html,/id="login-password"[^>]*minlength="8"/);
 assert.match(html,/同一账号标识限领一次，注销重注册不补发/);assert.match(html,/防重复领取赠送时长的标记/);assert.match(html,/data-toggle-password="login-password"/);
 assert.match(app,/minLength=passwordRegister\?NEW_PASSWORD_MIN:8/);assert.match(app,/passwordFormProblem\(/);assert.match(app,/window\.addEventListener\('pagehide',\(\)=>cancelRegistration\(\)\)/);assert.match(app,/addEventListener\('input',[\s\S]*?cancelRegistration\('内容已更改/);
 assert.match(security,/newPasswordError\(data\.newPassword,accountUsername\)/);assert.match(security,/newPasswordError\(data\.newPassword,resetUsername\)/);assert.match(build,/src\/registration-proof-worker\.js/);
 assert.doesNotMatch(html+app,/人机已验证|粘贴禁止/);
});

test('browser fetch keeps its Window receiver while the client runs as a class instance',async()=>{
 const workers=workerFactory(worker=>queueMicrotask(()=>worker.onmessage({data:{solution:42}})));
 async function browserFetch(path){assert.equal(this,globalThis,'native browser fetch rejects a RegistrationClient receiver');return Response.json(path.endsWith('/challenge')?challenge():{user:{id:'receiver-safe'}});}
 const client=new RegistrationClient({workerFactory:()=>workers.create(),fetcher:browserFetch});
 assert.equal((await client.register(credentials)).user.id,'receiver-safe');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {accountRequest} from '../src/account-client.js';
import {passwordFormProblem} from '../src/form-feedback.js';

test('registration explains invalid credentials at the relevant field before sending a request',()=>{
 const form={username:'7612',password:'!76129876',confirmation:'!76129876',registering:true};
 assert.equal(passwordFormProblem(form).field,'login-password');
 assert.match(passwordFormProblem(form).message,/账号名/);
 for(const username of ['','a','-user','ab c','中文账号'])assert.equal(passwordFormProblem({...form,username}).field,'login-username');
 for(const password of ['','short7!','abcdefgh','87654329','!#%@&$()'])assert.equal(passwordFormProblem({...form,username:'flowtest',password}).field,'login-password');
 for(const password of ['Pine482k','Lake#Day','42!83#17'])assert.equal(passwordFormProblem({...form,username:'flowtest',password,confirmation:password}),null);
 assert.equal(passwordFormProblem({...form,username:'flowtest',password:'Pine482k',confirmation:'Different7!'}).field,'password-confirm');
 assert.equal(passwordFormProblem({...form,username:'flowtest',password:'oldpassw',registering:false}),null,'legacy passwords must still reach login');
});

test('account requests use same-origin cookies, no cache and the native fetch receiver',async()=>{
 const data=await accountRequest('/api/account/login/password',{body:{username:'testuser',password:'Pine482k'},fetcher:async function(path,options){
  assert.equal(this,globalThis);assert.equal(path,'/api/account/login/password');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).username,'testuser');return Response.json({user:{id:'test-id'}});
 }});
 assert.equal(data.user.id,'test-id');
});

test('network errors, non-JSON gateway pages and duplicate-account responses have useful messages',async()=>{
 await assert.rejects(accountRequest('/api/account',{fetcher:async()=>{throw new TypeError('Failed to fetch');}}),/检查网络/);
 await assert.rejects(accountRequest('/api/account',{fetcher:async()=>new Response('<html>Bad gateway</html>',{status:502})}),/服务返回异常/);
 await assert.rejects(accountRequest('/api/account/register/password',{fetcher:async()=>Response.json({error:{message:'这个账号已注册，请直接登录或换一个账号。'}},{status:409})}),error=>error.status===409&&error.message.includes('已注册'));
});

test('stalled account requests time out and a later retry succeeds',async()=>{
 let calls=0;
 const fetcher=async(_,options)=>{if(++calls===2)return Response.json({user:{id:'recovered'}});return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};
 await assert.rejects(accountRequest('/api/account/login/password',{timeoutMs:15,fetcher}),/连接超时/);
 assert.equal((await accountRequest('/api/account/login/password',{timeoutMs:100,fetcher})).user.id,'recovered');
});

test('cancellation aborts the fetch and never becomes a misleading network failure',async()=>{
 const controller=new AbortController();
 const pending=accountRequest('/api/account/register/challenge',{signal:controller.signal,fetcher:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}))});
 controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
});

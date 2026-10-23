import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_PAGES,profileRoute,profilePath,profileLoginDestination} from '../src/profile-routes.js';
import {handle} from '../src/worker.js';
import {environment} from './server-fixture.mjs';

test('every personal-center page supports a direct request and reload; unknown routes stay 404',async()=>{
 for(const [view,page] of Object.entries(PROFILE_PAGES)){
  const response=await handle(new Request('https://example.test'+page.path));assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Type'),/text\/html/);assert.equal(profileRoute(page.path),view);assert.equal(profileRoute(page.path+'/'),view);
  assert.equal(profilePath(view),page.path);
 }
 for(const path of ['/profile/unknown','/profile/security/other','/profile.evil','/profiles/security'])assert.equal((await handle(new Request('https://example.test'+path))).status,404);
});
test('login return is limited to real local pages; old deletion links reach the data page',()=>{
 assert.equal(profileRoute('/profile','?deleting=1'),'data');assert.equal(profileRoute('/profile/data','?deleting=1'),'data');
 assert.equal(profileLoginDestination('?login=1&next=security'),'security');assert.equal(profileLoginDestination('?login=1&next=data'),'data');
 for(const value of ['https://evil.test','//evil.test','/profile/data','constructor','__proto__','not-a-page',''])assert.equal(profileLoginDestination('?next='+encodeURIComponent(value)),'overview');
});
test('loading new pages grants no access to protected data or administration',async()=>{
 const {env}=environment();
 for(const path of ['/api/account/security','/api/history','/api/admin/security'])assert.equal((await handle(new Request('https://example.test'+path),undefined,env)).status,path.startsWith('/api/admin/')?503:401);
 for(const path of ['/api/account/password/change','/api/account/data/export','/api/account/delete']){
  const request=new Request('https://example.test'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'注销并删除'})});
  assert.equal((await handle(request,undefined,env)).status,401);
 }
});

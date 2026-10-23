import {TRANSLATION_INSTRUCTIONS} from '../src/translation-prompt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handle} from '../src/worker.js';
import {authHeaders} from '../src/access.js';
import {localApi} from '../src/local-api.js';
test('personal credentials cannot call text or audio endpoints',async()=>{
 for(const route of ['/api/openai/responses','/api/openai/token'])for(const mode of ['', 'member']){
  let called=false;
  const r=await handle(new Request('https://example.test'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer sk-personal-only-test','X-Access-Mode':mode},body:JSON.stringify({input:'hello',instructions:TRANSLATION_INSTRUCTIONS})}),async()=>{called=true;throw Error('must not call');});
  assert.equal(r.status,401);assert.equal(called,false);
 }
 assert.deepEqual(authHeaders('sk-personal-only-test'),{'X-Access-Mode':'member'});
 await assert.rejects(()=>localApi('/api/config',{method:'POST',body:JSON.stringify({key:'sk-personal-only-test'})}),/仅支持会员/);
});
test('frontend has no personal key fields, links, or handlers',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(html,/API Key|id="api-key"|id="access-key"|id="key-pane"|platform\.openai\.com\/api-keys/);
 assert.doesNotMatch(app,/\$\('(api-key|access-key|key-pane|get-key-link)'\)|selectAccess|个人 API/);
});

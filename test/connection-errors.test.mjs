import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/worker.js';
import {consume} from '../src/member.js';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {environment,req} from './server-fixture.mjs';
import {BrowserLive} from '../src/live.js';
import {closeFailedConnection} from '../src/live-failure.js';
import {activateClientMembership,memberHandle} from './access-fixture.mjs';
async function fixture(){
 const {env,sql}=environment();
 const account=await createVerifiedAccountSession(env,{provider:'phone',subject:'+8613800138000',label:'Connection test'});
 const cookie=account.cookie.split(';')[0];
 await handle(req('/api/member/login',{code:'test-member-code'},cookie),()=>{throw Error('No upstream expected');},env);
 return {env,sql,cookie};
}
test('connection preflight requires membership and does not spend connection attempts',async()=>{
 const {env,sql,cookie}=await fixture();
 const status=c=>handle(req('/api/openai/status',undefined,c),()=>{throw Error('No upstream expected');},env);
 assert.equal((await status('')).status,401);
 for(let i=0;i<5;i++)assert.deepEqual(await (await status(cookie)).json(),{available:true});
 assert.equal(sql.prepare("SELECT count(*) AS n FROM usage_buckets WHERE id LIKE 'realtime-%'").get().n,0);
 await consume(env,'realtime-day',12,86400,12);
 const exhausted=await (await status(cookie)).json();
 assert.equal(exhausted.available,false);assert.equal(exhausted.code,'daily_connection_limit');assert.ok(exhausted.retryAt>Date.now());
 assert.match(exhausted.message,/本站今天/);
 let called=false;
 const response=await handle(req('/api/openai/token',{sourceLanguage:'auto'},cookie,{'X-Access-Mode':'member'}),async()=>{called=true;return Response.json({});},env);
 assert.equal(response.status,429);assert.equal(called,false);assert.equal((await response.json()).error.message,exhausted.message);
});
test('connection rate limit resets at the next minute and is distinct from the daily limit',async t=>{
 const {env,sql,cookie}=await fixture();const now=Date.now();t.mock.method(Date,'now',()=>now);
 const id=sql.prepare('SELECT id FROM accounts').get().id;
 await consume(env,'realtime-minute:'+id,3,60,3);
 const status=()=>handle(req('/api/openai/status',undefined,cookie),()=>{throw Error('No upstream');},env).then(r=>r.json());
 const limited=await status();assert.equal(limited.code,'connection_rate_limit');
 t.mock.method(Date,'now',()=>limited.retryAt);assert.deepEqual(await status(),{available:true});
});
test('API credit exhaustion, rate limits, access and configuration have safe distinct messages',async()=>{
 for(const [status,code,expected] of [[429,'insufficient_quota','insufficient_quota'],[429,'rate_limit_exceeded','upstream_rate_limit'],[401,'invalid_api_key','upstream_authentication'],[403,'permission_denied','upstream_access'],[400,'invalid_request_error','upstream_configuration']]){
  const response=await memberHandle(req('/api/openai/token',{sourceLanguage:'auto'}),async()=>Response.json({error:{code,message:'secret sk-test-do-not-return',extra:'private'}},{status}));
  const body=await response.json();assert.equal(body.error.code,expected);assert.doesNotMatch(JSON.stringify(body),/sk-test|private/);
 }
});
test('startup token failure survives intentional close instead of becoming connection interrupted',async t=>{
 await activateClientMembership();
 const message='本站今天的实时连接次数已用完';
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message}},{status:429}));
 const live=new BrowserLive();live.session={id:'failed-start',title:'Test',segments:[],warnings:[],sourceLanguage:'auto'};
 live.persist=async()=>{};
 let displayed='';
 live.onclose=()=>{displayed='连接中断';};
 live.onmessage=({data})=>{const e=JSON.parse(data);if(e.type==='fatal'){closeFailedConnection(live);displayed=e.message;}};
 await live.connect().catch(error=>live.emit({type:'fatal',message:error.message}));
 await Promise.resolve();assert.equal(displayed,message);assert.equal(live.readyState,3);assert.equal(live.onmessage,null);
});

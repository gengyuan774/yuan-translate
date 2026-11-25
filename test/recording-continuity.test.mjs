import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reconnectWithBackoff} from '../src/connection-recovery.js';
import {initRecordingLifecycle} from '../src/recording-lifecycle.js';
import {BrowserLive} from '../src/live.js';
import {activateClientMembership} from './access-fixture.mjs';
test('transient reconnects back off, respect retryAt, and succeed without another manual start',async()=>{
 let now=0,calls=0;const delays=[];
 const result=await reconnectWithBackoff(async()=>{calls++;if(calls===1)throw Error('network');if(calls===2)throw Object.assign(Error('rate limit'),{retryAt:10000});return 'ready';},{now:()=>now,wait:async ms=>{delays.push(ms);now+=ms;}});
 assert.equal(result,'ready');assert.equal(calls,3);assert.deepEqual(delays,[1500,8500]);
});
test('offline recovery waits for connectivity and never retries account, quota or credential denials',async()=>{
 let online=false,calls=0;
 await reconnectWithBackoff(async()=>{calls++;},{online:()=>online,wait:async()=>{online=true;}});assert.equal(calls,1);
 for(const failure of [{code:'recording_busy'},{code:'translation_quota_exhausted'},{code:'upstream_authentication'},{status:403}]){
  calls=0;await assert.rejects(()=>reconnectWithBackoff(async()=>{calls++;throw Object.assign(Error('terminal'),failure);},{wait:async()=>assert.fail('must not retry')}));assert.equal(calls,1);
 }
});
test('cancelling recovery prevents later attempts and offline waits are bounded',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(()=>reconnectWithBackoff(async()=>{calls++;throw Error('network');},{signal:controller.signal,wait:async()=>controller.abort()}),{name:'AbortError'});assert.equal(calls,1);
 let now=0;await assert.rejects(()=>reconnectWithBackoff(async()=>assert.fail('offline'),{online:()=>false,now:()=>now,wait:async ms=>{now+=ms;},maxMs:10000}));assert.equal(now,10000);
});
function lifecycleFixture(){
 const win=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible';let active=true,saved=0,recovered=0,exited=0;
 const dispose=initRecordingLifecycle({win,doc,active:()=>active,persist:async()=>saved++,recover:async()=>recovered++,exit:()=>exited++});
 const fire=(target,type,fields={})=>{const event=new Event(type);Object.assign(event,fields);target.dispatchEvent(event);};
 return {win,doc,dispose,fire,stop:()=>active=false,state:()=>({saved,recovered,exited})};
}
test('tab hiding and back/forward cache do not stop recording; returning restores it, actual exit cleans up',async()=>{
 const f=lifecycleFixture();f.doc.visibilityState='hidden';f.fire(f.doc,'visibilitychange');f.fire(f.win,'pagehide',{persisted:true});assert.equal(f.state().exited,0);
 f.fire(f.win,'pageshow',{persisted:true});await Promise.resolve();assert.equal(f.state().recovered,1);
 f.fire(f.win,'pagehide',{persisted:false});assert.equal(f.state().exited,1);f.stop();f.fire(f.win,'online');assert.equal(f.state().recovered,1);f.dispose();
});
test('Android freeze persists and marks a system interruption; resume errors are handled and the next recovery remains possible',async()=>{
 const win=new EventTarget(),doc=new EventTarget();let frozen=0,saved=0,recovered=0;const failures=[];
 const dispose=initRecordingLifecycle({win,doc,active:()=>true,persist:async()=>saved++,freeze:async()=>frozen++,exit:()=>assert.fail('freeze is not an exit'),recover:async()=>{recovered++;if(recovered===1)throw Error('audio suspended');},failed:e=>failures.push(e.message)});
 doc.dispatchEvent(new Event('freeze'));await new Promise(r=>setImmediate(r));assert.equal(saved,1);assert.equal(frozen,1);
 doc.dispatchEvent(new Event('resume'));await new Promise(r=>setImmediate(r));assert.deepEqual(failures,['audio suspended']);
 doc.dispatchEvent(new Event('resume'));await new Promise(r=>setImmediate(r));assert.equal(recovered,2);dispose();
 doc.dispatchEvent(new Event('freeze'));doc.dispatchEvent(new Event('resume'));assert.equal(recovered,2);
});
function liveFixture(t){
 const live=new BrowserLive(),events=[];live.session={id:'continuity-test',title:'Test',status:'recording',sourceLanguage:'en',translationMode:'accurate',warnings:[],segments:[]};
 live.paused=false;live.hasRecorded=true;live.persist=async()=>{};live.turns={flush(){},push(){}};live.onmessage=({data})=>events.push(JSON.parse(data));t.after(()=>live.close());return {live,events};
}
test('an active class recovers once on the same owner and reports the missing interval',async t=>{
 const {live,events}=liveFixture(t),owner=live.connectionOwner;let release,calls=0;
 live.connect=async()=>{calls++;await new Promise(resolve=>release=resolve);await live.handle({type:'session.updated'});};
 const first=live.recoverConnection();void live.recoverConnection();release();await first;
 assert.equal(calls,1);assert.equal(live.connectionOwner,owner);assert.equal(live.paused,false);assert.equal(live.session.status,'recording');assert.equal(events.filter(e=>e.type==='ready').length,1);assert.match(live.session.warnings[0],/无法补回/);
});
test('manual pause or finish cancels a pending recovery and cannot silently restart the microphone',async t=>{
 for(const action of ['pause','finish']){
  const {live,events}=liveFixture(t);live.finalize=async()=>{};
  live.connect=async(wait,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError'))));
  const recovery=live.recoverConnection();await live.command({type:action});await recovery;
  assert.equal(live.paused,true);assert.equal(events.some(e=>e.type==='ready'),false);
 }
});
test('a replaced socket cannot complete a newer handshake or trigger recovery',async t=>{
 const {live,events}=liveFixture(t);live.upstream={close(){}};
 await live.handle({type:'session.updated'},{});await live.handle({type:'error',error:{retryable:true}},{});
 assert.equal(events.length,0);assert.equal(live.renewing,undefined);
});
test('real client socket handlers automatically replace a broken connection once and keep the same classroom',async t=>{
 await activateClientMembership();const sockets=[];
 class Socket{
  constructor(url){this.url=url;this.readyState=1;sockets.push(this);}
  send(){}
  close(){this.readyState=3;this.onclose?.();}
 }
 t.mock.property(globalThis,'WebSocket',Socket);globalThis.location={href:'https://example.test/',protocol:'https:'};t.after(()=>delete globalThis.location);
 t.mock.method(globalThis,'fetch',async()=>Response.json({available:true}));
 const {live,events}=liveFixture(t),owner=live.connectionOwner,session=live.session;
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const first=live.connect(true);await tick();sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'session.updated'})});await first;
 sockets[0].onerror();sockets[0].onclose?.();await tick();assert.equal(sockets.length,2);
 sockets[1].onopen();sockets[1].onmessage({data:JSON.stringify({type:'session.updated'})});await live.renewal;
 assert.equal(live.session,session);assert.equal(new URL(sockets[1].url).searchParams.get('owner'),owner);assert.equal(events.filter(e=>e.type==='recovered').length,1);assert.equal(live.paused,false);
});

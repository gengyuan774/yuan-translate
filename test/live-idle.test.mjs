import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserLive} from '../src/live.js';
function setup(t){
 let now=1000;t.mock.method(Date,'now',()=>now);
 const live=new BrowserLive(),events=[];
 live.session={id:'idle-test',status:'recording',sourceLanguage:'en',segments:[],warnings:[]};
 live.persist=async()=>{};live.paused=false;live.turns={flush(){},push(){}};
 live.onmessage=e=>events.push(JSON.parse(e.data));live.resetIdle();
 t.after(()=>live.close());
 return {live,events,advance:ms=>{now+=ms;}};
}
test('only ten minutes without nonempty recognition pauses, and only once',async t=>{
 const {live,events,advance}=setup(t);
 advance(599999);live.checkIdle();assert.equal(live.paused,false);
 live.noteTranscript('hello');advance(599999);live.noteTranscript('  ');live.checkIdle();assert.equal(live.paused,false);
 advance(1);live.checkIdle();assert.equal(live.paused,true);assert.equal(live.session.status,'paused');
 live.checkIdle();assert.equal(events.filter(e=>e.type==='idle').length,1);
 const last=live.lastTranscriptAt;live.noteTranscript('late result');assert.equal(live.lastTranscriptAt,last);
 live.upstream={readyState:1,close(){}};live.connectedAt=Date.now();live.appliedLanguage='en';
 await live.command({type:'resume'});assert.equal(live.paused,false);
 advance(599999);live.checkIdle();assert.equal(live.paused,false);advance(1);live.checkIdle();assert.equal(live.paused,true);
});
test('active class continues beyond 55 minutes and renews without resetting idle or emitting ready',async t=>{
 const {live,events,advance}=setup(t);live.connectedAt=Date.now();
 for(let i=0;i<56;i++){advance(60000);live.noteTranscript('new speech');live.checkIdle();}
 assert.equal(live.paused,false);const last=live.lastTranscriptAt;
 let connected=false,pushed=0,release;
 live.connect=async()=>{connected=true;await new Promise(r=>release=r);live.turns={push:b=>pushed+=b.length,flush(){}};await live.handle({type:'session.updated'});};
 const renewal=live.renew();assert.equal(connected,true);live.send(new ArrayBuffer(4800));
 release();await renewal;
 assert.equal(live.paused,false);assert.equal(pushed,4800);assert.equal(live.lastTranscriptAt,last);
 assert.equal(events.some(e=>['ready','idle','limit'].includes(e.type)),false);
});
test('manual pause during renewal stays paused when buffered audio is restored',async t=>{
 const {live,events}=setup(t);live.connectedAt=Date.now();let release;
 live.connect=async()=>{await new Promise(r=>release=r);await live.handle({type:'session.updated'});};
 const renewal=live.renew();await live.command({type:'pause'});release();await renewal;
 assert.equal(live.paused,true);assert.equal(live.session.status,'paused');assert.equal(events.some(e=>e.type==='ready'),false);
});
test('renewal failure pauses with an actionable message',async t=>{
 const {live,events}=setup(t);live.connect=async()=>{throw Error('network unavailable');};
 await live.renew();assert.equal(live.paused,true);assert.equal(live.renewing,false);assert.equal(events.at(-1).type,'fatal');
});

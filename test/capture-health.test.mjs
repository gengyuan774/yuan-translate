import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorCapture,resumeAudioContext} from '../src/capture-health.js';
function fixture(t){
 let now=1000,active=true,visible=true;const interruptions=[],recoveries=[];
 const track=Object.assign(new EventTarget(),{readyState:'live',muted:false,enabled:true});
 const context=Object.assign(new EventTarget(),{state:'running'});
 const monitor=monitorCapture({active:()=>active,visible:()=>visible,now:()=>now,interrupted:reason=>{interruptions.push(reason);active=false;},available:()=>recoveries.push(true)});
 monitor.bind(track,context);t.after(()=>monitor.dispose());
 return {track,context,monitor,interruptions,recoveries,advance:ms=>now+=ms,active:value=>active=value,visible:value=>visible=value};
}
test('background alone leaves capture running, system mute pauses once and unmute restores only in foreground',t=>{
 const f=fixture(t);f.visible(false);f.advance(30000);f.monitor.check();assert.deepEqual(f.interruptions,[]);
 f.track.muted=true;f.track.dispatchEvent(new Event('mute'));f.monitor.check();assert.deepEqual(f.interruptions,['muted']);
 f.track.muted=false;f.track.dispatchEvent(new Event('unmute'));assert.equal(f.recoveries.length,0);
 f.visible(true);f.monitor.check();f.monitor.check();assert.equal(f.recoveries.length,1);
});
test('lock-screen AudioContext interruption is detected even while the WebSocket and track are live',t=>{
 const f=fixture(t);f.visible(false);f.context.state='interrupted';f.context.dispatchEvent(new Event('statechange'));assert.deepEqual(f.interruptions,['context']);
 f.visible(true);f.monitor.check();assert.equal(f.recoveries.length,0);
 f.context.state='running';f.context.dispatchEvent(new Event('statechange'));assert.equal(f.recoveries.length,1);
});
test('silent PCM frames are healthy; missing frames in a visible running context are not',t=>{
 const f=fixture(t);
 for(let i=0;i<100;i++){f.advance(1000);f.monitor.frame();f.monitor.check();}assert.deepEqual(f.interruptions,[]);
 f.advance(6000);f.monitor.check();assert.deepEqual(f.interruptions,['stalled']);
});
test('returning from a throttled tab allows capture callbacks to restart before declaring a stall',t=>{
 const f=fixture(t);f.visible(false);f.advance(90000);f.visible(true);f.monitor.returned();f.monitor.check();assert.deepEqual(f.interruptions,[]);
 f.advance(5999);f.monitor.check();assert.deepEqual(f.interruptions,[]);f.advance(1);f.monitor.check();assert.deepEqual(f.interruptions,['stalled']);
});
test('manual pause and finish never trigger capture recovery or silently reopen a microphone',t=>{
 const f=fixture(t);f.active(false);f.track.muted=true;f.track.dispatchEvent(new Event('mute'));f.context.state='suspended';f.context.dispatchEvent(new Event('statechange'));f.advance(60000);f.monitor.check();
 assert.deepEqual(f.interruptions,[]);assert.deepEqual(f.recoveries,[]);
});
test('replaced tracks are detached and a fresh ready state starts a new observation interval',t=>{
 const f=fixture(t),old=f.track,next=Object.assign(new EventTarget(),{readyState:'live',muted:false});
 f.monitor.bind(next,f.context);old.dispatchEvent(new Event('ended'));assert.deepEqual(f.interruptions,[]);
 next.readyState='ended';next.dispatchEvent(new Event('ended'));assert.deepEqual(f.interruptions,['ended']);
 next.readyState='live';f.active(true);f.monitor.reset();f.monitor.check();assert.equal(f.interruptions.length,1);
 f.monitor.dispose();next.dispatchEvent(new Event('ended'));assert.equal(f.interruptions.length,1);
});
test('context resume cannot leave the continue button waiting forever or claim success while still interrupted',async()=>{
 await assert.rejects(()=>resumeAudioContext({state:'interrupted',resume:()=>new Promise(()=>{})},{timeoutMs:20}),/点击继续录音/);
 await assert.rejects(()=>resumeAudioContext({state:'interrupted',resume:async()=>{}},{timeoutMs:20}),/尚未恢复/);
 const context={state:'suspended',resume:async()=>{context.state='running';}};await resumeAudioContext(context);assert.equal(context.state,'running');
 await assert.rejects(()=>resumeAudioContext({state:'closed'}),/重新连接/);
});

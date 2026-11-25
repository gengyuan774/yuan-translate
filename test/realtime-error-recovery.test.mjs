import test from 'node:test';
import assert from 'node:assert/strict';
import {MeteredAudio} from '../src/realtime-relay.js';

test('temporary provider server errors permit reconnect without leaking provider details',async()=>{
 const events=[],audio=new MeteredAudio(null,null,null,()=>{},event=>events.push(event));
 await audio.event({type:'error',error:{type:'server_error',code:'internal_error',message:'Private provider diagnostic',event_id:'private-request-id'}});
 assert.deepEqual(events,[{type:'error',error:{message:'语音识别服务暂时异常，正在尝试恢复。',code:'upstream_unavailable',retryable:true}}]);
});
test('quota, authentication, invalid requests and unknown errors do not create automatic retry loops',async()=>{
 for(const error of [{type:'invalid_request_error'},{type:'server_error',code:'insufficient_quota'},{type:'server_error',code:'invalid_api_key'},{type:'server_error',code:'model_not_found'},{type:'server_error',code:'permission_denied'},{}]){
  const events=[],audio=new MeteredAudio(null,null,null,()=>{},event=>events.push(event));await audio.event({type:'error',error:{...error,message:'Private detail'}});
  assert.equal(events[0].error.retryable,undefined);assert.ok(!JSON.stringify(events).includes('Private detail'));
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {acquireLease,recoverExpired,myUsage} from '../src/service-ledger.js';
import {MeteredAudio} from '../src/realtime-relay.js';

test('transcription arriving after its reservation was refunded cannot deliver free results or translation authorization',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'late-audio-'+crypto.randomUUID()+'@test.example'}),cookie=account.cookie.split(';')[0];
 const request=req('/api/openai/realtime',undefined,cookie),lease=await acquireLease(request,env),events=[];
 const audio=new MeteredAudio(request,env,lease,()=>{},event=>events.push(event));
 try{
  await audio.append(Buffer.alloc(48000).toString('base64'));await audio.commit();
  await audio.event({type:'input_audio_buffer.committed',item_id:'late-audio-turn'});
  assert.equal((await myUsage(request,env)).reservedMinutes,1/60);
  t.mock.method(Date,'now',()=>now+121000);await recoverExpired(env);
  const before=await myUsage(request,env);assert.equal(before.usedMinutes,0);assert.equal(before.reservedMinutes,0);
  assert.equal(sql.prepare("SELECT state FROM service_requests WHERE account_id=? AND kind='audio'").get(account.user.id).state,'failed');
  await audio.event({type:'conversation.item.input_audio_transcription.completed',item_id:'late-audio-turn',transcript:'This result arrived after the refund.'});
  assert.equal(events.some(event=>event.type==='conversation.item.input_audio_transcription.completed'),false);
  assert.equal(events.some(event=>event.type==='conversation.item.input_audio_transcription.failed'||event.type==='warning'||event.type==='error'),true);
  assert.doesNotMatch(JSON.stringify(events),/audioProof|sourceProof|translationProof|audio_proof/);
  const after=await myUsage(request,env);assert.equal(after.usedMinutes,0);assert.equal(after.reservedMinutes,0);
 }finally{await audio.close();}
});

test('empty trial transcription does not throw while issuing a translation receipt',async()=>{
 const {env}=environment(),account=await createVerifiedAccountSession(env,{provider:'email',subject:'empty-trial-audio-'+crypto.randomUUID()+'@test.example'}),cookie=account.cookie.split(';')[0];
 const request=req('/api/openai/realtime',undefined,cookie),lease=await acquireLease(request,env),events=[];
 const audio=new MeteredAudio(request,env,lease,()=>{},event=>events.push(event));
 try{
  await audio.append(Buffer.alloc(48000).toString('base64'));await audio.commit();
  await audio.event({type:'input_audio_buffer.committed',item_id:'empty-trial-turn'});
  await assert.doesNotReject(audio.event({type:'conversation.item.input_audio_transcription.completed',item_id:'empty-trial-turn',transcript:''}));
  assert.doesNotMatch(JSON.stringify(events),/audioProof|sourceProof|translationProof|audio_proof/);
  assert.equal(audio.closed,false);
  assert.equal((await myUsage(request,env)).usedMinutes,1/60);
  assert.equal((await myUsage(request,env)).reservedMinutes,0);
 }finally{await audio.close();}
});

test('a paid connection falling back to the trial signs newly trial-billed audio',async t=>{
 const {env,sql}=environment(),now=Date.now();t.mock.method(Date,'now',()=>now);
 const account=await createVerifiedAccountSession(env,{provider:'email',subject:'tier-transition-audio-'+crypto.randomUUID()+'@test.example'}),cookie=account.cookie.split(';')[0];
 sql.prepare("UPDATE account_memberships SET tier='regular',expires_at=?,updated_at=?,quota_anchor=? WHERE account_id=?").run(now+1000,now,now,account.user.id);
 const request=req('/api/openai/realtime',undefined,cookie),lease=await acquireLease(request,env),events=[];
 assert.equal(lease.tier,'regular');
 const audio=new MeteredAudio(request,env,lease,()=>{},event=>events.push(event));
 try{
  t.mock.method(Date,'now',()=>now+2000);
  await audio.append(Buffer.alloc(48000).toString('base64'));await audio.commit();
  await audio.event({type:'input_audio_buffer.committed',item_id:'trial-after-paid-expiry'});
  await audio.event({type:'conversation.item.input_audio_transcription.completed',item_id:'trial-after-paid-expiry',transcript:'This voice segment used the remaining free trial.'});
  const completed=events.find(event=>event.type==='conversation.item.input_audio_transcription.completed');
  assert.equal(typeof completed?.audioProof,'string');
  const usage=await myUsage(request,env);assert.equal(usage.tier,'trial');assert.equal(usage.usedMinutes,1/60);
 }finally{await audio.close();}
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateText,translateSegment} from '../src/core.js';
import {TranscriptMerger} from '../src/transcript-merge.js';
import {localApi} from '../src/local-api.js';
import {getSession,saveSession} from '../src/storage.js';
import {activateClientMembership} from './access-fixture.mjs';
const lesson=segments=>({id:crypto.randomUUID(),title:'课堂',major:{code:'general'},segments,materials:[]});
const output=()=>Response.json({output:[{content:[{type:'output_text',text:'译文'}]}]});

test('translation requests carry audio proofs only when supplied',async()=>{
 const bodies=[],fetcher=async(path,init)=>{bodies.push(JSON.parse(init.body));return output();};
 await generateText('member','fixed translation','input',{fetcher});assert.equal(bodies[0].sourceProofs,undefined);assert.equal(bodies[0].translationSource,undefined);
 const sourceProofs=[{source:'Spoken text.',proof:'signed-source-proof'}];
 await generateText('member','fixed translation','input',{fetcher,sourceProofs,translationSource:'Spoken text.'});
 assert.deepEqual(bodies[1].sourceProofs,sourceProofs);assert.equal(bodies[1].translationSource,'Spoken text.');
});

test('repeated identical speech selects the current row proof instead of an older occurrence',async()=>{
 const source='Thank you.',rows=[{source,audioProof:'old-proof'},{source,audioProof:'current-proof'}];let options;
 await translateSegment(lesson(rows),'member',source,'',async(k,i,input,opts)=>{options=opts;return '谢谢。';});
 assert.deepEqual(options.sourceProofs,[{source,proof:'current-proof'}]);assert.equal(options.translationSource,source);
});

test('merged fragments preserve each signed source and pass their proof list in spoken order',async()=>{
 let merged;const merger=new TranscriptMerger({submit:row=>merged=row,remove:()=>{},setTimer:()=>1,clearTimer:()=>{}});
 const first={id:'a',offset:0,source:'The main reason.',sourceLanguage:'en',audioProof:'first-proof'},second={id:'b',offset:2000,source:'is the increase in demand.',sourceLanguage:'en',audioProof:'second-proof'};
 merger.add(first);merger.add(second);assert.ok(merged);let options;
 await translateSegment(lesson([merged]),'member',merged.source,'',async(k,i,input,opts)=>{options=opts;return '主要原因是需求增加。';});
 assert.deepEqual(merged.sourceParts.map(p=>p.audioProof),['first-proof','second-proof']);
 assert.deepEqual(options.sourceProofs,[{source:first.sourceParts[0].source,proof:'first-proof'},{source:second.source,proof:'second-proof'}]);
 assert.equal(options.translationSource,'The main reason. is the increase in demand.');
});

test('queued repeated speech keeps the proof belonging to its exact audio row',async()=>{
 const source='Thank you.',rows=[{source,audioProof:'queued-first-proof'},{source,audioProof:'queued-later-proof'}];let options;
 await translateSegment(lesson(rows),'member',source,'',async(k,i,input,opts)=>{options=opts;return '谢谢。';},undefined,undefined,rows[0]);
 assert.deepEqual(options.sourceProofs,[{source,proof:'queued-first-proof'}]);
});

test('a saved 403 subtitle can be translated again once, using its own source and proof',async t=>{
 await activateClientMembership();
 const good={id:'previous',source:'Case zero.',translation:'案例零。',offset:1000,state:'translated'};
 const failed={id:'item-final',source:'This is right.',translation:'',offset:1020000,sourceLanguage:'en',audioProof:'original-proof',state:'failed',error:'OpenAI 请求失败（403）：此账号的 AI 服务暂时受限'};
 const s=lesson([good,failed]);await saveSession(s);
 const path='/api/sessions/'+s.id+'/retry-translation';
 const options={method:'POST',body:JSON.stringify({segmentId:failed.id})};
 let requests=0;const started=Promise.withResolvers(),gate=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(url,'/api/openai/responses');requests++;
  const body=JSON.parse(init.body);assert.deepEqual(body.sourceProofs,[{source:failed.source,proof:failed.audioProof}]);
  assert.match(body.input,/上文：Case zero\./);assert.ok(body.input.endsWith(failed.source));
  started.resolve();await gate.promise;
  return Response.json({output:[{content:[{type:'output_text',text:'这是对的。'}]}]});
 });
 const first=localApi(path,options);
 await assert.rejects(localApi(path,options),/完成当前课堂操作/);
 await Promise.race([started.promise,first]);
 const later={id:'later',source:'A later remark.',translation:'之后的补充。',offset:1025000,state:'translated'};
 await saveSession({...s,segments:[good,failed,later]});
 gate.resolve();await first;
 await localApi(path,options);assert.equal(requests,1);
 const saved=await getSession(s.id);assert.deepEqual(saved.segments[0],good);
 assert.deepEqual(saved.segments[2],later);
 assert.deepEqual(saved.segments[1],{id:failed.id,source:failed.source,translation:'这是对的。',offset:failed.offset,sourceLanguage:'en',audioProof:failed.audioProof,state:'translated',references:[]});
});

test('an active site restriction shows its local recovery time without misattributing the refusal',async()=>{
 const retryAt=Date.UTC(2026,10,19,21,35,20),localTime=new Date(retryAt).toLocaleString('zh-CN',{hour12:false});let calls=0;
 const fetcher=async()=>{calls++;return Response.json({error:{code:'account_restricted',retryAt,message:'暂时受限'}},{status:403});};
 await assert.rejects(generateText('member','translation','input',{fetcher}),error=>error.message.includes(localTime)&&!error.message.includes('OpenAI'));
 assert.equal(calls,1);
});

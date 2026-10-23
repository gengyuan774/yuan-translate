import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateText,translateSegment} from '../src/core.js';
import {TranscriptMerger} from '../src/transcript-merge.js';
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

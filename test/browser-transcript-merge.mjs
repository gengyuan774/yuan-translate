// Browser-only regression entry; bundle with esbuild and serve outside public/.
// Uses actual browser timers, synthetic transcripts, and mocked API responses.
import {TranscriptMerger} from '../src/transcript-merge.js';
import {BrowserLive} from '../src/live.js';
import {initTranscriptFollow} from '../src/transcript-follow.js';
import {refreshAccess} from '../src/access.js';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const row=(id,source)=>({id,source,offset:0,sourceLanguage:'en'});
export async function runBrowserRegression(){
 const submitted=[];
 const merger=new TranscriptMerger({submit:r=>submitted.push(r.source),remove:()=>{},maxWait:30});
 merger.add(row('complete','The teacher explains the main topic in detail.'));
 assert(submitted.length===1,'Complete sentence did not trigger translation');
 merger.add(row('fragment','Because.'));
 await new Promise(resolve=>setTimeout(resolve,60));
 assert(submitted.length===2,'Native timer did not flush the fragment');
 merger.add(row('a','The main reason.'));merger.add(row('b','is the increase in demand.'));
 assert(submitted.length===3,'Merged sentence was not submitted');
 assert(submitted[2]==='The main reason. is the increase in demand.','Merged source changed');
 const originalFetch=globalThis.fetch;let requests=0,streamDone=false,partialSeen=false;const live=new BrowserLive();
 const panel=document.createElement('div');panel.innerHTML='<input type="checkbox" checked><button>跟随最新</button><div class="test-transcript" style="height:120px;overflow:auto"></div>';document.body.append(panel);const container=panel.querySelector('div'),checkbox=panel.querySelector('input'),button=panel.querySelector('button'),follow=initTranscriptFollow(container,checkbox,button);
 follow.render('<div style="height:300px">前文</div><p id="stream-translation"></p>');
 live.onmessage=({data})=>{const e=JSON.parse(data);if(e.type==='translation'){if(!streamDone)partialSeen=true;follow.mutate(()=>{document.getElementById('stream-translation').textContent=e.translation;});}};
 try{
  globalThis.fetch=async path=>{
   if(path==='/api/member/status')return Response.json({member:true,sharedReady:true});
   assert(path==='/api/openai/responses','Unexpected API call');requests++;
   return new Response(new ReadableStream({start(controller){const send=e=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));send({type:'delta',text:'老师正在'});setTimeout(()=>{streamDone=true;send({type:'completed',text:'老师正在详细解释这个主题。'});controller.close();},150);}}),{headers:{'Content-Type':'text/event-stream'}});
  };
  await refreshAccess();live.persist=async()=>{};live.paused=false;live.started=Date.now();live.base=0;
  live.session={id:'browser-regression',title:'模拟课堂',sourceLanguage:'en',status:'recording',segments:[],materials:[],warnings:[]};
  await live.handle({type:'input_audio_buffer.committed',item_id:'real-timer'});
  await live.handle({type:'conversation.item.input_audio_transcription.completed',item_id:'real-timer',transcript:'The teacher explains the main topic in detail.'});
  await live.queue;
  assert(requests===1,'BrowserLive never called the translation endpoint');
  assert(live.session.segments[0].translation==='老师正在详细解释这个主题。','Chinese translation missing');
  assert(partialSeen,'Stream waited for completion before showing text');assert(document.getElementById('stream-translation').textContent==='老师正在详细解释这个主题。','Visible streamed Chinese missing');
  assert(container.scrollHeight-container.scrollTop-container.clientHeight<=4,'Streaming did not follow latest');checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));container.scrollTop=0;follow.mutate(()=>{document.getElementById('stream-translation').textContent+=' 阅读前文不跳走。'.repeat(20);});assert(container.scrollTop===0,'Streaming disturbed reading earlier text');assert(!button.hidden,'Return-to-latest button missing');button.click();assert(container.scrollHeight-container.scrollTop-container.clientHeight<=4,'Return-to-latest did not scroll');
  return 'PASS: incremental Chinese appears before completion; follow latest and reading older records both preserved;  complete sentence, timed fragment, phrase merging, and BrowserLive → translation request → Chinese output. Native browser timers; no real API calls.';
 }finally{live.close();globalThis.fetch=originalFetch;}
}

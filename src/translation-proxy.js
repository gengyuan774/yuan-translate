import {readEvents,responseText} from './text-stream.js';
import {upstreamError} from './upstream-error.js';
// Only publish translation text and our own error messages, never raw provider
// metadata, credentials, or arbitrary upstream error strings.
export function translationStream(body){
 const encoder=new TextEncoder();
 async function* events(){
  let text='';
  try{
   for await(const event of readEvents(body)){
    if(event.type==='response.output_text.delta'){text+=event.delta||'';yield {type:'delta',text:event.delta||''};}
    if(event.type==='response.completed'){
     if(event.response?.status==='incomplete')throw new Error();
     const finalText=responseText(event.response||{})||text;if(!finalText.trim())throw new Error();
     yield {type:'completed',text:finalText};return;
    }
    if(['error','response.failed','response.incomplete'].includes(event.type)){
     yield {type:'error',message:upstreamError(503,event.error||event.response?.error).message};return;
    }
   }
  }catch{}
  yield {type:'error',message:'翻译连接中断，已显示的译文可能不完整，请稍后重试。'};
 }
 const iterator=events();
 return new ReadableStream({async pull(controller){const {done,value}=await iterator.next();if(done)controller.close();else controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));},async cancel(){await iterator.return();}});
}

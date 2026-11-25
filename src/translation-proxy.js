import {readEvents,responseText} from './text-stream.js';
import {upstreamError} from './upstream-error.js';
// Only publish translation text and our own error messages, never raw provider
// metadata, credentials, or arbitrary upstream error strings.
export function translationStream(body,{finish=async()=>{}}={}){
 const encoder=new TextEncoder(),abort=new AbortController();
 let success=false,usage=null,settlement;
 const settle=()=>settlement??=Promise.resolve().then(()=>finish({success,usage}));
 async function* events(){
  let text='',terminal={type:'error',message:'翻译连接中断，已显示的译文可能不完整，请稍后重试。'};
  try{
   for await(const event of readEvents(body,{signal:abort.signal})){
    if(event.type==='response.output_text.delta'){text+=event.delta||'';yield {type:'delta',text:event.delta||''};}
    if(event.type==='response.completed'){
     usage=event.response?.usage||null;
     if(event.response?.status==='incomplete')throw new Error();
     const finalText=responseText(event.response||{})||text;if(!finalText.trim())throw new Error();
     success=true;terminal={type:'completed',text:finalText};break;
    }
    if(['error','response.failed','response.incomplete'].includes(event.type)){
     usage=event.response?.usage||null;
     terminal={type:'error',message:upstreamError(503,event.error||event.response?.error).message};break;
    }
   }
  }catch{}
  finally{await settle();}
  if(!abort.signal.aborted)yield terminal;
 }
 const iterator=events();
 return new ReadableStream({
  async pull(controller){
   const {done,value}=await iterator.next();if(abort.signal.aborted)return;
   if(done)controller.close();else controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));
  },
  async cancel(){
   abort.abort();
   try{if(body&&!body.locked)await body.cancel();await iterator.return();}
   finally{await settle();}
  }
 });
}

// Parse SSE across arbitrary byte boundaries (including multibyte Chinese text).
export async function* readEvents(body){
 if(!body)throw new Error('没有收到翻译内容，请重试。');
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data=[];
 function line(value){if(value===''){const result=data.join('\n');data=[];return result||null;}if(value.startsWith('data:'))data.push(value.slice(5).replace(/^ /,''));return null;}
 try{
  while(true){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
   let index;while((index=buffer.indexOf('\n'))>=0){const event=line(buffer.slice(0,index).replace(/\r$/,''));buffer=buffer.slice(index+1);if(event&&event!=='[DONE]')yield JSON.parse(event);}
   if(buffer.length>2000000)throw new Error('翻译内容过长。');
   if(done){if(buffer)line(buffer.replace(/\r$/,''));const event=line('');if(event&&event!=='[DONE]')yield JSON.parse(event);break;}
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export const responseText=data=>data.output?.flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
export async function collectTranslation(body,onDelta){
 let text='';
 for await(const event of readEvents(body)){
  if(event.type==='delta'){text+=event.text||'';onDelta(text);}
  if(event.type==='error')throw new Error(event.message||'翻译连接中断，已显示的译文可能不完整。');
  if(event.type==='completed'){text=event.text||text;if(!text.trim())throw new Error('OpenAI 未返回文字，请重试。');onDelta(text);return text;}
 }
 throw new Error('翻译连接中断，已显示的译文可能不完整，请稍后重试。');
}

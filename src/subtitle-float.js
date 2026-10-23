export function initSubtitleFloat({button,transcript,partial,status,timer,message,title,onReturn,notify,host=window}){
 let floating=null,opening=false,observer=null,resizeObserver=null;
 const reset=()=>{
  observer?.disconnect();observer=null;resizeObserver?.disconnect();resizeObserver=null;floating=null;
  button.setAttribute('aria-pressed','false');
  button.title='点击将实时字幕悬浮在桌面上';
 };
 const returnToPage=()=>{
  onReturn();host.focus();floating?.close();
  button.focus({preventScroll:true});
 };
 async function open(){
  if(opening)return;
  if(floating&&!floating.closed){floating.focus();return;}
  if(typeof host.documentPictureInPicture?.requestWindow!=='function'){
   notify('当前浏览器不支持桌面悬浮字幕，请使用桌面版 Chrome 或 Edge 打开本页。');return;
  }
  opening=true;
  try{
   // Keep the request directly inside the click gesture required by the browser.
   floating=await host.documentPictureInPicture.requestWindow({width:620,height:380,disallowReturnToOpener:false});
   const doc=floating.document;
   doc.documentElement.lang='zh-CN';
   const stylesheet=doc.createElement('link');stylesheet.rel='stylesheet';
   stylesheet.href=new URL('/subtitle-float.css',host.location.href).href;doc.head.append(stylesheet);
   const element=(tag,className,text)=>{const node=doc.createElement(tag);node.className=className;if(text)node.textContent=text;return node;};
   const header=element('header','floating-heading'),heading=element('div','floating-title');
   const label=element('strong','','实时字幕'),course=element('small','floating-course');
   heading.append(label,course);
   const back=element('button','floating-return','返回页面 ↗');back.type='button';back.addEventListener('click',returnToPage);
   header.append(heading,back);
   const captions=element('main','floating-transcript');captions.tabIndex=0;captions.setAttribute('aria-label','最新原文与中文字幕');
   const pending=element('div','floating-partial'),alert=element('p','floating-message');alert.setAttribute('role','status');
   const footer=element('footer','floating-footer'),state=element('span','floating-status'),clock=element('time','floating-timer');
   footer.append(state,clock);doc.body.replaceChildren(header,captions,pending,alert,footer);
   let previousHTML=null;
   const sync=()=>{
    course.textContent=title.textContent;doc.title=(title.textContent||'实时字幕')+' · 满绩速翻';
    state.textContent=status.textContent;clock.textContent=timer.textContent;
    pending.textContent=partial.textContent;pending.hidden=partial.hidden||!partial.textContent;
    alert.textContent=message.textContent;alert.hidden=message.hidden||!message.textContent;
    // Only mirror the latest four segments; the full classroom stays on the page.
    const rows=Array.from(transcript.querySelectorAll('.segment')).slice(-4);
    const html=rows.map(row=>row.outerHTML).join('');
    if(html!==previousHTML){
     previousHTML=html;
     captions.replaceChildren(...rows.map(row=>doc.importNode(row,true)));
     if(!rows.length)captions.append(element('p','floating-empty','字幕会在开始上课后显示。可先返回页面，点击「开始上课」。'));
     captions.scrollTop=captions.scrollHeight;
    }
   };
   observer=new host.MutationObserver(sync);
   for(const node of [transcript,partial,status,timer,message,title])observer.observe(node,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
   if(host.ResizeObserver){resizeObserver=new host.ResizeObserver(()=>{captions.scrollTop=captions.scrollHeight;});resizeObserver.observe(captions);}
   floating.addEventListener('pagehide',reset,{once:true});
   stylesheet.addEventListener('load',()=>{captions.scrollTop=captions.scrollHeight;},{once:true});
   button.setAttribute('aria-pressed','true');button.title='字幕已悬浮，点击查看悬浮窗';sync();
  }catch(error){
   floating?.close();reset();
   notify(error.name==='NotAllowedError'?'浏览器未允许打开字幕悬浮窗，请返回页面重新点击「实时字幕」。':'暂时无法打开字幕悬浮窗，请使用桌面版 Chrome 或 Edge 重试。');
  }finally{opening=false;}
 }
 button.addEventListener('click',open);
 host.addEventListener('pagehide',()=>{floating?.close();reset();});
 return {open};
}

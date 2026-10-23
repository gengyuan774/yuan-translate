import {readCloudClass} from './recovery-client.js';
import {downloadNotes} from './download.js';
import {renderNotes} from '../public/format.js';
const $=id=>document.getElementById(id);
let session;
async function load(){
 $('retry').disabled=true;$('login').hidden=true;$('record').hidden=true;
 $('message').textContent='正在读取云端课堂…';
 try{
  const result=await readCloudClass(new URLSearchParams(location.search).get('classroom'));session=result.session;
  $('title').textContent=session.title||'课堂记录';
  const start=new Date(session.createdAt);
  $('details').textContent=`${result.user.label} · ${Number.isNaN(start.getTime())?'':start.toLocaleString('zh-CN')} · ${session.segments.length} 段记录`;
  $('summary').innerHTML=renderNotes(session.summary||'这节课尚未保存总结。');
  const rows=document.createDocumentFragment();
  for(const s of session.segments){
   if(!s.source?.trim()&&!s.translation?.trim())continue;
   const row=document.createElement('article');row.className='segment';
   const source=document.createElement('p');source.className='source';source.textContent=s.source||'';
   const translation=document.createElement('p');translation.textContent=s.translation||'（此段暂无译文）';
   row.append(source,translation);rows.append(row);
  }
  $('transcript').replaceChildren(rows);$('record').hidden=false;
  $('message').textContent='已读取云端保存的记录，可在下方阅读和下载。';
 }catch(e){session=null;$('message').textContent=e.status===404?'当前登录账号下没有这节课，请确认使用保存课堂时的账号。':e.message;$('login').hidden=e.status!==401;}
 finally{$('retry').disabled=false;}
}
$('retry').addEventListener('click',load);
for(const button of document.querySelectorAll('[data-download]'))button.addEventListener('click',async()=>{
 if(!session)return;button.disabled=true;
 try{await downloadNotes(session,button.dataset.download);$('message').textContent='文件已生成，请在浏览器下载列表中查看。';}
 catch(e){$('message').textContent='下载失败：'+e.message;}finally{button.disabled=false;}
});
load();

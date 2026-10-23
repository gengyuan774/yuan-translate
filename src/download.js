import {exportHtml,exportMarkdown} from './core.js';
const formats={'pdf-summary':'application/pdf','pdf-transcript':'application/pdf',pdf:'application/pdf',md:'text/markdown;charset=utf-8',html:'text/html;charset=utf-8'};
export function downloadFilename(title,format){
 if(!formats[format])throw new Error('不支持的下载格式');
 const name=String(title||'课堂笔记').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'-').replace(/[\u202a-\u202e\u2066-\u2069]/g,'').replace(/^[.\s]+|[.\s]+$/g,'').slice(0,100)||'课堂笔记';
 const suffix=format==='pdf-summary'?' - 课堂总结':format==='pdf-transcript'?' - 中英文对照记录':'';
 return name+suffix+'.'+(format.startsWith('pdf')?'pdf':format);
}
export async function notesFile(session,format,{pdfExporter}={}){
 const name=downloadFilename(session.title,format);
 let contents;
 if(format.startsWith('pdf')){
  const exporter=pdfExporter||(await import('/pdf-export.js')).exportPdf;
  contents=await exporter(session,{scope:format==='pdf-summary'?'summary':format==='pdf-transcript'?'transcript':'all'});
 }else contents=format==='html'?exportHtml(session):exportMarkdown(session);
 return {name,blob:new Blob([contents],{type:formats[format]})};
}
export async function downloadNotes(session,format='pdf'){
 const {name,blob}=await notesFile(session,format);
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;
 document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 return name;
}

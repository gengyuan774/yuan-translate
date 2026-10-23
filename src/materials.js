import {getMaterial} from './storage.js';
export async function activeMaterials(s){return Promise.all((s.materials||[]).filter(m=>m.enabled!==false).map(m=>getMaterial(s.id,m.id)));}
const stopWords=new Set('the and for that this with from are you have will what about was were has had can could would should into also than then they their them these those there here how why when where which who does did please explain means mean lecture slide slides today thank thanks okay 这个 那个 什么 我们 你们 就是 可以'.split(' '));
function tokens(text){
 const words=String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
 return new Set(words.flatMap(word=>{
  if(/[\u3400-\u9fff]/u.test(word))return Array.from({length:Math.max(0,word.length-1)},(_,i)=>word.slice(i,i+2));
  // Recognize common English plurals while keeping short acronyms intact.
  if(/^[a-z]{5,}s$/.test(word)&&!word.endsWith('ss'))word=word.endsWith('ies')?word.slice(0,-3)+'y':word.slice(0,-1);
  return [word];
 }).filter(word=>word.length>=2&&!stopWords.has(word)));
}
function passages(text){
 const result=[];
 for(let start=0;start<text.length;){
  let end=Math.min(text.length,start+1300);
  if(end<text.length){
   const boundary=[...text.slice(start,end).matchAll(/\n|[.!?。！？](?:\s|$)/gu)].at(-1);
   if(boundary&&boundary.index>650)end=start+boundary.index+boundary[0].length;
  }
  result.push({text:text.slice(start,end),start,end});
  if(end===text.length)break;start=end-180;
 }
 return result;
}
export async function referenceContext(session,query,max=4000){
 const terms=tokens(query);if(!terms.size)return {text:'',references:[]};
 const materials=await activeMaterials(session),candidates=[];
 for(const m of materials)for(const [pageIndex,page] of m.pages.entries()){
  for(const passage of passages(page.text)){
   const words=tokens(passage.text),matches=[...terms].filter(term=>words.has(term));
   if(matches.length)candidates.push({id:m.id,name:m.name,label:page.label,pageIndex,...passage,matches});
  }
 }
 const frequency=new Map();for(const p of candidates)for(const term of p.matches)frequency.set(term,(frequency.get(term)||0)+1);
 for(const p of candidates)p.score=p.matches.reduce((sum,term)=>sum+Math.log(1+candidates.length/frequency.get(term)),0);
 candidates.sort((a,b)=>b.score-a.score);
 let text='',references=[],selected=[];for(const p of candidates){
  if(selected.some(previous=>previous.text===p.text||(previous.id===p.id&&previous.pageIndex===p.pageIndex&&Math.min(previous.end,p.end)-Math.max(previous.start,p.start)>Math.min(previous.text.length,p.text.length)/2)))continue;
  const block=`[资料：${p.name}，${p.label}]\n${p.text}\n`;if(text.length+block.length>max)continue;
  text+=block;selected.push(p);references.push({id:p.id,name:p.name,label:p.label});if(selected.length>=6)break;
 }
 references=references.filter((r,i,a)=>a.findIndex(x=>x.id===r.id&&x.label===r.label)===i);
 return {text,references};
}
export function sourceList(session){return (session.materials||[]).filter(m=>m.enabled!==false).map(m=>({id:m.id,name:m.name,pageCount:m.pageCount,warnings:m.warnings||[]}));}

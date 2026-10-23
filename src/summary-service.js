import {MemberError} from './errors.js';
import {normalizeMajor} from './majors.js';
import {TEXT_MODEL} from './models.js';
import {responseText} from './text-stream.js';
import {meteredText} from './metered-text.js';
import {beginSummary,finishSummary} from './service-ledger.js';
import {generateSummary,SUMMARY_VERSION} from './summary-content.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bad=()=>{throw new MemberError('总结内容格式不正确。',400);};
const field=(value,max,{empty=true}={})=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))bad();return value.replace(/\r\n?/g,'\n');};
const warnings=value=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>20)bad();return value.map(w=>field(w,500));};
export function normalizeSummarySnapshot(input){
 if(!record(input)||!Array.isArray(input.segments)||input.segments.length>30000||!Array.isArray(input.materials)||input.materials.length>10)bad();
 let major;try{major=normalizeMajor(input.major);}catch{bad();}
 const snapshot={title:field(input.title,120,{empty:false}),major,warnings:warnings(input.warnings),segments:[],materials:[]};
 let transcriptChars=0,materialChars=0;
 for(const segment of input.segments){
  if(!record(segment)||!Number.isFinite(segment.offset)||segment.offset<0||segment.offset>7*24*3600000)bad();
  const source=field(segment.source,20000);transcriptChars+=source.length;
  if(source.trim())snapshot.segments.push({offset:Math.floor(segment.offset),source});
 }
 if(transcriptChars>1000000)throw new MemberError('课堂记录过长，请分段生成总结。',413);
 const ids=new Set();
 for(const material of input.materials){
  if(!record(material)||!uuid(material.id)||ids.has(material.id)||!Array.isArray(material.pages)||!material.pages.length||material.pages.length>300)bad();
  ids.add(material.id);
  const pages=material.pages.map(page=>{if(!record(page))bad();return {label:field(page.label,120,{empty:false}),text:field(page.text,200000)};});
  const characters=pages.reduce((n,p)=>n+p.text.length,0);materialChars+=characters;
  if(characters>200000)throw new MemberError('单份资料文字超过 20 万字符，请拆分后再试。',413);
  // Derive page count from the submitted, selected text snapshot.
  snapshot.materials.push({id:material.id,name:field(material.name,240,{empty:false}),pageCount:pages.length,warnings:warnings(material.warnings),pages});
 }
 if(materialChars>500000)throw new MemberError('本次资料文字超过 50 万字符，请减少勾选资料后重试。',413);
 if(!snapshot.segments.length&&!snapshot.materials.some(m=>m.pages.some(p=>p.text.trim())))throw new MemberError('请先录入课堂内容或导入参考资料。',400);
 if(JSON.stringify(snapshot).length>1800000)throw new MemberError('总结内容过长，请减少勾选资料后重试。',413);
 return snapshot;
}
async function inputHash(snapshot){
 const bytes=new TextEncoder().encode(JSON.stringify({version:SUMMARY_VERSION,model:TEXT_MODEL,snapshot}));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
const reply=(result,cached=false)=>Response.json({...result,...(cached?{cached:true}:{})},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function summarizeService(request,env,data,upstream){
 if(!record(data)||!uuid(data.id))bad();
 const snapshot=normalizeSummarySnapshot(data.snapshot),hash=await inputHash(snapshot),deadline=Date.now()+14*60*1000;
 const keepActive=()=>{if(request.signal.aborted||Date.now()>=deadline)throw new MemberError('总结处理已中断或超时，次数已返还，请稍后重试。',503);};
 const row=await beginSummary(request,env,{id:data.id,inputHash:hash});
 if(row.state==='completed'){
  const result=typeof row.result==='string'?JSON.parse(row.result):row.result;
  if(!record(result)||typeof result.summary!=='string'||!result.summary.trim())throw new MemberError('已保存的总结暂时无法读取，请联系客服。',503);
  return reply(result,true);
 }
 try{
  const result=await generateSummary(snapshot,async(instructions,input,options={})=>{
   keepActive();
   const response=await meteredText(request,env,{model:TEXT_MODEL,instructions,input,store:false,max_output_tokens:options.maxTokens??4000},upstream);
   const output=await response.json();
   keepActive();
   if(!response.ok)throw new MemberError(output.error?.message||'总结服务暂不可用，请稍后重试。',response.status);
   const text=responseText(output);if(output.status==='incomplete'||!text.trim())throw new MemberError('总结未完整生成，次数已返还，请稍后重试。',503);
   return text;
  });
  await finishSummary(env,row,{success:true,result:JSON.stringify(result)});
  return reply(result);
 }catch(error){
  await finishSummary(env,row,{success:false});
  throw error instanceof MemberError?error:new MemberError('总结未完成，次数已返还，请稍后重试。',503);
 }
}

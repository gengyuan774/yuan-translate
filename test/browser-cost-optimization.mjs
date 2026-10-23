// Browser-only regression: bundle outside public/ and run on a local test origin.
// Reload the page after the first pass to verify persistence across JS contexts.
import {summarize} from '../src/core.js';
import {referenceContext} from '../src/materials.js';
import {setAccount,saveSession,getSession,saveMaterial} from '../src/storage.js';
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const pointer='cost-regression-classroom';
export async function runBrowserCostRegression(){
 setAccount(null);let calls=0;
 const generate=async()=>{calls++;return '浏览器测试笔记：CPI 为消费价格指数，2026 年上涨 2.5%。';};
 const existing=sessionStorage.getItem(pointer);
 if(existing){
  const s=await getSession(existing),result=await summarize(s,'mock',generate);
  assert(result.includes('2.5%'),'Reload lost summary text');
  assert(calls===0,'Reload issued another generation request');
  return 'PASS：刷新后摘要仍可复用；本次生成请求为 0。真实浏览器 IndexedDB；未调用 OpenAI。';
 }
 const id=crypto.randomUUID(),s={id,title:'本地测试课堂',createdAt:new Date().toISOString(),status:'ended',sourceLanguage:'en',segments:[{source:'The CPI rose by 2.5% in 2026.',offset:0}],materials:[],warnings:[]};
 await saveSession(s);
 const m={id:crypto.randomUUID(),name:'本地测试课件.txt',enabled:true,pageCount:2,warnings:[],pages:[{label:'第 1 页',text:'CPI means Consumer Price Index. CPI rose by 2.5% in 2026.'},{label:'第 2 页',text:'Photosynthesis converts light energy into chemical energy.'}]};
 await saveMaterial(id,m);s.materials.push({...m,pages:undefined});await saveSession(s);
 const context=await referenceContext(s,'The CPI rose this year.');
 assert(context.text.includes('Consumer Price Index')&&context.text.includes('2.5%'),'Relevant definition or number was lost');
 assert(!context.text.includes('Photosynthesis')&&context.text.length<=4000,'Unrelated material retained or budget exceeded');
 const first=await summarize(s,'mock',generate),second=await summarize(await getSession(id),'mock',generate);
 assert(first===second&&calls===1,'Repeated summary was not reused');
 const changed=structuredClone(s);changed.segments.push({source:'The interest rate is 5%.',offset:2000});await summarize(changed,'mock',generate);
 assert(calls===2,'Changed classroom did not regenerate');
 sessionStorage.setItem(pointer,id);
 return 'PASS：相关术语与数字保留，无关页已排除；重复总结复用，内容变化重新生成。请刷新验证持久化。未调用 OpenAI。';
}

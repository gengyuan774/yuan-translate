// Repeatable, synthetic two-hour PDF export fixture. Never uses account data.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {exportPdf} from '../src/pdf-export.js';
const [directory]=process.argv.slice(2);if(!directory?.startsWith('/'))throw Error('Provide an absolute output directory.');
await mkdir(directory,{recursive:true});
const fontBytes=await readFile(new URL('../public/export-font.ttf',import.meta.url));
const session={title:'验收样例 · 两小时课堂',createdAt:'2026-11-11T20:00:00Z',sourceLanguage:'en',major:{code:'economics'},summary:'## 课堂概览\n本例用于验收导出排版，所有内容均为测试数据。\n## 核心知识点\n- 机会成本是放弃的最佳替代方案的价值。\n- CPI 表示消费者价格指数；本例同比上升 2%。\n- MPT 与 CAPM 是本节课的两个专业缩写。\n## 公式与数字\nE(Ri) = Rf + beta × [E(Rm) - Rf]\n示例数值：3.14、£20、8%、120 分钟。\n## 复习问题\n解释风险与收益的关系，并用自己的话区分投资组合分散化与资本配置。',warnings:[],materials:[],segments:Array.from({length:240},(_,i)=>({id:'qa-'+i,offset:i*30000,source:`Sentence ${i+1}. The opportunity cost is the value of the next best alternative. CPI increased by two percent, while the risk-free rate was five percent.`,translation:`第 ${i+1} 段。机会成本是放弃的最佳替代方案的价值。消费者价格指数上涨了百分之二，无风险利率为百分之五。`}))};
const outputs=[];
for(const scope of ['summary','transcript']){const bytes=await exportPdf(session,{fontBytes,scope});const path=directory+'/'+scope+'.pdf';await writeFile(path,bytes);const pdf=await PDFDocument.load(bytes);outputs.push({scope,path,pages:pdf.getPageCount(),bytes:bytes.length});}
await writeFile(directory+'/report.json',JSON.stringify({workload:'Local production exporter with 240 synthetic bilingual segments; no WeChat or phone viewer; browser-only font fallback excluded',outputs},null,2));console.log(JSON.stringify(outputs));

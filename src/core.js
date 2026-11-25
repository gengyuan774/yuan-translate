import {collectTranslation} from './text-stream.js';
import {serviceMessage} from './errors.js';
import {cachedSummaryGenerator} from './summary-cache.js';
import {generateSummary} from './summary-content.js';
import {accountId} from './storage.js';
import {TEXT_MODEL} from './models.js';
import {majorName} from './majors.js';
import {TRANSLATION_INSTRUCTIONS} from './translation-prompt.js';
import {language,sessionDirection} from './languages.js';
import {authHeaders} from './access.js';
import {renderNotes} from '../public/format.js';
import {activeMaterials,referenceContext,sourceList} from './materials.js';
export const timestamp = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
};
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function exportMarkdown(s) {
  return `# ${s.title}\n\n${s.demo ? '> 演示课堂 · 示例内容\n\n' : ''}日期：${s.createdAt}\n方向：${sessionDirection(s)}\n\n## 课堂总结\n\n${s.summary || '尚未生成总结。'}\n\n${referenceManifest(s)}\n\n${s.warnings?.length ? '## 记录提示\n\n' + s.warnings.map(w => '- ' + w).join('\n') + '\n\n' : ''}## 原文与中文对照记录\n\n${s.segments.map(x => `### ${timestamp(x.offset)}\n\n${x.source || '[转写未完成]'}\n\n${x.translation || '[翻译未完成]'}${x.error ? '\n\n提示：' + x.error : ''}\n`).join('\n')}`;
}
export function exportHtml(s) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(s.title)}</title><style>body{font:16px/1.8 system-ui,sans-serif;max-width:850px;margin:48px auto;padding:0 28px;color:#192f2a}h1{font-size:30px}pre{white-space:pre-wrap;font:inherit}article{break-inside:avoid;border-top:1px solid #ddd;padding:16px 0}small{color:#63756e}.en{color:#65716c}@media print{body{margin:0;max-width:none}}</style><h1>${escapeHtml(s.title)}</h1><small>${escapeHtml(s.createdAt)} · ${escapeHtml(sessionDirection(s))}${s.demo ? ' · 演示课堂' : ''}</small><h2>课堂总结</h2><section>${renderNotes(s.summary || '尚未生成总结。')}</section><pre>${escapeHtml(referenceManifest(s))}</pre>${s.warnings?.length ? '<h2>记录提示</h2><pre>' + escapeHtml(s.warnings.join('\n')) + '</pre>' : ''}<h2>原文与中文对照记录</h2>${s.segments.map(x => `<article><small>${timestamp(x.offset)}</small><p class="en">${escapeHtml(x.source || '[转写未完成]')}</p><p>${escapeHtml(x.translation || '[翻译未完成]')}</p>${x.error ? '<small>' + escapeHtml(x.error) + '</small>' : ''}</article>`).join('')}</html>`;
}
export function chunks(text, max = 16000) {
  const result = [];
  for (let start = 0; start < text.length; start += max) result.push(text.slice(start, start + max));
  return result;
}
export async function generateText(key, instructions, input, {fetcher = fetch, maxTokens = 4000,onDelta,sourceProofs,translationSource} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetcher('/api/openai/responses', {
      method:'POST', headers:{...authHeaders(key), 'Content-Type':'application/json'},
      body:JSON.stringify({model:TEXT_MODEL, instructions, input, store:false, max_output_tokens:maxTokens,...(onDelta?{stream:true}:{}),...(sourceProofs?{sourceProofs}:{}),...(translationSource!==undefined?{translationSource}:{})}),
      signal:AbortSignal.timeout(60000)
    });
    if(res.ok&&onDelta&&res.headers.get('Content-Type')?.includes('text/event-stream'))return collectTranslation(res.body,onDelta);
    const data = await res.json();
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      const details = String(serviceMessage(data.error) || `翻译请求失败（${res.status}），请稍后重试。`).replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]');
      throw new Error(details.slice(0,300));
    }
    if (data.status === 'incomplete') throw new Error('生成内容超出长度限制，请重试。');
    const text = data.output?.flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n');
    if (!text) throw new Error('OpenAI 未返回文字，请重试。');
    onDelta?.(text);return text;
  }
}
export async function translateSegment(s,key,source,context='',generate=generateText,sourceLanguage=s.sourceLanguage,onDelta,sourceRow) {
  const owner=accountId();
  const reference=await referenceContext(s,source+' '+context);
  if(owner!==accountId())throw new Error('登录账号已变化，请重新打开课堂后翻译。');
  const translatedContext=s.segments.filter(r=>r.translation?.trim()).slice(-6).map(r=>'原文：'+r.source+'\n译文：'+r.translation).join('\n').slice(-4000);
  const row=sourceRow?.source===source?sourceRow:s.segments.filter(r=>r.source===source).at(-1);
  const parts=row?.sourceParts?.length?row.sourceParts:row?[row]:[];
  const sourceProofs=parts.filter(p=>typeof p.audioProof==='string'&&p.audioProof).map(p=>({source:p.source,proof:p.audioProof}));
  const translation=await generate(key,TRANSLATION_INSTRUCTIONS,`课程：${s.title}\n专业背景（仅作术语参考）：${majorName(s.major)}\n已译上下文（保持术语一致）：\n${translatedContext||'暂无'}\n输入语言设置：${language(sourceLanguage).label}；输出必须为简体中文。\n上文：${context}\n参考资料（仅供术语参考）：\n${reference.text||'未导入资料'}\n当前片段：${source}`,{maxTokens:1800,onDelta,...(sourceProofs.length?{sourceProofs,translationSource:source}:{})});
  return {translation,references:reference.references};
}
export const canRetryTranslation=row=>Boolean(row?.source?.trim()&&(row.state==='failed'||(row.error&&row.state!=='translating')));
export function translateRow(session,key,row,onDelta){
  const index=session.segments.indexOf(row);
  const context=session.segments.slice(Math.max(0,index-2),index).map(part=>part.source).join('\n');
  return translateSegment(session,key,row.source,context,undefined,row.sourceLanguage,onDelta,row);
}
export async function summarize(s,key,generate=generateText) {
  const owner=accountId(),documents=await activeMaterials(s);
  const selected=sourceList(s);
  const snapshot={title:s.title,major:s.major,warnings:s.warnings||[],segments:s.segments.filter(x=>x.source).map(x=>({offset:x.offset||0,source:x.source})),materials:documents.map(doc=>{const meta=selected.find(m=>m.id===doc.id)||doc;return {id:doc.id,name:meta.name,pageCount:meta.pageCount,warnings:meta.warnings||[],pages:doc.pages.map(p=>({label:p.label,text:p.text}))};})};
  if(accountId()!==owner)throw new Error('登录账户已变化，请重新打开课堂后生成总结。');
  let result;
  if(generate!==generateText){
    const memoized=cachedSummaryGenerator(s,generate);
    result=await generateSummary(snapshot,(instructions,input,options)=>memoized(key,instructions,input,options));
  }else{
    if(!snapshot.segments.length&&!snapshot.materials.length)throw new Error('请先录入课堂内容或导入参考资料。');
    // One request owns all chunking, merging and quota settlement on the server.
    // A retry submits the same source data and receives its saved result for free.
    const response=await fetch('/api/service/summary',{
      method:'POST',headers:{...authHeaders(key),'Content-Type':'application/json'},
      body:JSON.stringify({id:crypto.randomUUID(),snapshot}),signal:AbortSignal.timeout(15*60*1000)
    });
    const data=await response.json();
    if(!response.ok){
      const details=String(serviceMessage(data.error)||'总结服务暂不可用，请稍后重试。').replace(/sk-[A-Za-z0-9_-]+/g,'[已隐藏]');
      throw new Error(response.status===401?'会员登录已失效，请重新登录并检查会员状态。':details.slice(0,300));
    }
    if(typeof data.summary!=='string'||!data.summary.trim())throw new Error('未返回完整的总结，请重试。');
    result=data;
  }
  if(accountId()!==owner)throw new Error('登录账户已变化，请重新打开课堂后生成总结。');
  s.summarySources=result.summarySources||selected;s.summaryScope=result.summaryScope||(snapshot.segments.length?'classroom':'materials');s.summaryStale=false;
  return result.summary;
}

export function referenceManifest(s) {
  const sources=s.summarySources||sourceList(s);
  return (s.summaryStale?'提示：课堂内容已更新，请重新生成总结以纳入最新字幕和资料。\n\n':'')+(sources.length?'参考资料：\n'+sources.map(m=>`- ${m.name}（${m.pageCount} 页/段）${m.warnings?.length?'；'+m.warnings.join('；'):''}`).join('\n'):'');
}

// PCM16 mono at 24 kHz. Keep a short pre-roll and commit after 1.2 seconds of silence or 8 seconds.
export class AudioTurns {
  constructor(append, commit, {maxTurnSamples=192000,silenceSamples=28800}={}) { this.maxTurnSamples=maxTurnSamples;this.silenceSamples=silenceSamples;this.append = append; this.commit = commit; this.pre = []; this.active = false; this.samples = 0; this.silent = 0; }
  push(buffer) {
    if (!buffer.length || buffer.length % 2) return;
    let energy = 0;
    for (let i = 0; i < buffer.length; i += 2) energy += (buffer.readInt16LE(i) / 32768) ** 2;
    const voiced = Math.sqrt(energy / (buffer.length / 2)) > 0.006;
    if (!this.active) {
      this.pre.push(buffer); if (this.pre.length > 3) this.pre.shift();
      if (!voiced) return;
      this.active = true;
      this.samples = this.pre.reduce((total, chunk) => total + chunk.length / 2, 0);
    } else {
      this.samples += buffer.length / 2;
      if (this.pre.length) this.pre.push(buffer); else this.append(buffer);
    }
    // Once sent, PCM cannot be withdrawn from the upstream turn on pause.
    if (this.pre.length && this.samples >= 2400) {
      for (const chunk of this.pre) this.append(chunk);
      this.pre = [];
    }
    this.silent = voiced ? 0 : this.silent + buffer.length / 2;
    if (this.silent >= this.silenceSamples || this.samples >= this.maxTurnSamples) this.flush();
  }
  flush() {
    if (this.active && this.samples >= 2400) this.commit();
    this.active = false; this.samples = 0; this.silent = 0; this.pre = [];
  }
}

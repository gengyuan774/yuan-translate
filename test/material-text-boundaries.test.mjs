import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {extractMaterial,pdfPageText} from '../src/material-parser.js';

for(const extension of ['txt','docx'])test(extension+' preserves a full Unicode character at a 3000-unit page boundary',async()=>{
 const text='课'.repeat(2999)+'🧪讲义';
 const file=extension==='txt'?Buffer.from(text):Buffer.from(zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:document>')}));
 const {pages}=await extractMaterial(file,'lecture.'+extension);
 assert.equal(pages.length,2);assert.ok(pages.every(p=>p.text.isWellFormed()));
 assert.equal(pages.map(p=>p.text).join(''),text);
});
test('Windows, classic Mac and Unix line breaks all preserve paragraph separation',async()=>{
 for(const newline of ['\r\n','\r','\n']){
  const {pages}=await extractMaterial(Buffer.from('第一条'+newline+'第二条'),'notes.md');
  assert.equal(pages[0].text,'第一条\n第二条');
 }
});
test('plain text accepts 199999 and 200000 units and rejects the first over the limit',async()=>{
 for(const size of [199999,200000]){
  const result=await extractMaterial(Buffer.from('字'.repeat(size)),'notes.txt');assert.equal(result.characters,size);
 }
 await assert.rejects(extractMaterial(Buffer.from('字'.repeat(200001)),'notes.txt'),/20 万/);
});
test('PDF extraction reads all chunks on a browser stream without an asynchronous iterator',async()=>{
 const stream=new ReadableStream({start(c){
  c.enqueue({items:[{type:'beginMarkedContent'},{str:'示例',hasEOL:true}]});
  c.enqueue({items:[{str:'第二行'}]});c.close();
 }});
 Object.defineProperty(stream,Symbol.asyncIterator,{value:undefined});
 let cleaned=false;assert.equal(await pdfPageText({streamTextContent:()=>stream,cleanup(){cleaned=true;}},7),'示例\n第二行 ');
 assert.equal(cleaned,true);assert.equal(stream.locked,false);
});
test('crossing the remaining PDF text budget cancels extraction and releases the page',async()=>{
 let cancelled=false,cleaned=false;
 const stream=new ReadableStream({start(c){c.enqueue({items:[{str:'12345'}]});},cancel(){cancelled=true;}});
 await assert.rejects(pdfPageText({streamTextContent:()=>stream,cleanup(){cleaned=true;}},5),/超过 20 万/);
 assert.equal(cancelled,true);assert.equal(cleaned,true);assert.equal(stream.locked,false);
});

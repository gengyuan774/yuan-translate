import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function fixture(){
 const elements=new Map(),listeners=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
 const context=vm.createContext({$,current:{id:'class-one'},summarySyncNoticeId:null,accountId:()=> 'account-one',sessionSyncPending:async()=>true,pendingSync:new Set(),historyWarning:'',window:{addEventListener:(type,fn)=>listeners.set(type,fn)}});
 vm.runInContext(source.slice(source.indexOf('function notice('),source.indexOf('function recordingConflict('))+source.slice(source.indexOf('async function summaryReady('),source.indexOf('async function api('))+source.split('\n').find(line=>line.startsWith("window.addEventListener('history-sync'")),context);
 return {context,$,sync:detail=>listeners.get('history-sync')({detail}),ready:()=>vm.runInContext('summaryReady()',context)};
}
test('summary notice follows successful cloud save and cannot replace a newer message',async()=>{
 const f=fixture();await f.ready();assert.match(f.$('message').textContent,/同步待完成/);
 f.sync({owner:'account-one',id:'class-one',pending:false});assert.match(f.$('message').textContent,/完整笔记已保存到账户/);
 await f.ready();vm.runInContext("notice('新的操作失败')",f.context);f.sync({owner:'account-one',id:'class-one',pending:false});assert.equal(f.$('message').textContent,'新的操作失败');
});
test('a late summary save cannot update another account or classroom',async()=>{
 const f=fixture();await f.ready();f.sync({owner:'other-account',id:'class-one',pending:false});assert.match(f.$('message').textContent,/同步待完成/);
 let release;f.context.sessionSyncPending=()=>new Promise(resolve=>release=resolve);const ready=f.ready();f.context.current={id:'class-two'};f.$('message').textContent='第二节课';release(true);await ready;assert.equal(f.$('message').textContent,'第二节课');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const guard=source.match(/let loginCheckBusy=false;\nasync function requireLogin\(\)\{[\s\S]*?\n\}/)[0];
async function run(user,status=200,cached={id:'account-a'}){
 const events=[];const context=vm.createContext({profileUser:cached,config:{},AbortSignal,fetch:async()=>({ok:status===200,status,json:async()=>({user})}),window:{location:{assign:url=>events.push(url)}},notice:msg=>events.push(msg),applyAccount:()=>{},accountId:()=>cached?.id||null,current:null,rememberClassroom:()=>{},refreshAccess:async()=>({}),renderAccess:()=>{},renderProfileAccount:()=>{}});
 const allowed=await vm.runInContext(guard+'\nrequireLogin()',context);return {allowed,events};
}
test('guest and expired server sessions redirect despite cached login state',async()=>{
 for(const [user,status,cached] of [[null,200,null],[null,200,{id:'account-a'}],[null,401,{id:'account-a'}]]){
  const result=await run(user,status,cached);assert.equal(result.allowed,false);assert.deepEqual(result.events,['/profile?login=1']);
 }
});
test('verified account proceeds, changed account reloads safely, failures stop the action',async()=>{
 assert.deepEqual(await run({id:'account-a'}),{allowed:true,events:[]});
 assert.deepEqual(await run({id:'account-b'}),{allowed:false,events:['/profile?login=1']});
 const failed=await run(null,503);assert.equal(failed.allowed,false);assert.match(failed.events[0],/无法确认登录/);
});
test('start and membership buttons await server login validation',()=>{
 assert.match(source,/async function begin\(\)\{[\s\S]*?if\(!await requireLogin\(\)\)return;/);
 assert.match(source,/async function openSettings\(\).*if\(!await requireLogin\(\)\)return;/);
 assert.match(source,/\$\('setup-open'\)\.onclick=openSettings/);
});

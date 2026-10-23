import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberClassroom,restoreClassroom} from '../src/classroom-navigation.js';
const storage=()=>{const data=new Map();return {setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k),removeItem:k=>data.delete(k)};};
test('reauthentication restores the selected class with PPT, only once',async()=>{
 const store=storage(),classroom={id:'class-a',materials:[{id:'ppt-a',name:'lecture.pptx'}]};
 rememberClassroom('owner-a',classroom.id,store);
 assert.equal(await restoreClassroom('owner-a',async id=>{assert.equal(id,classroom.id);return classroom;},store),classroom);
 assert.equal(await restoreClassroom('owner-a',()=>assert.fail('must not reload'),store),null);
});
test('other accounts and expired return links cannot open the previous classroom',async()=>{
 const store=storage();rememberClassroom('owner-a','class-a',store);
 assert.equal(await restoreClassroom('owner-b',()=>assert.fail('cross-account read'),store),null);
 store.setItem('classroom-login-return',JSON.stringify({owner:'owner-a',id:'class-a',expires:0}));
 assert.equal(await restoreClassroom('owner-a',()=>assert.fail('expired read'),store),null);
});
test('temporary cloud failures retain the return pointer for retry',async()=>{
 const store=storage();rememberClassroom('owner-a','class-a',store);
 await assert.rejects(restoreClassroom('owner-a',async()=>{throw new Error('offline');},store),/offline/);
 assert.equal(await restoreClassroom('owner-a',async id=>id,store),'class-a');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {passwordFormProblem} from '../src/form-feedback.js';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const submit=source.slice(source.indexOf("$('password-form').onsubmit="),source.indexOf("$('redeem-form').onsubmit="));
function setup(overrides={}){
 const feedback=[],messages=[],elements=new Map();
 const $=id=>{if(!elements.has(id))elements.set(id,{value:({'login-username':'flowtest','login-password':'Pine482k','password-confirm':'Pine482k'})[id]||'',hidden:true});return elements.get(id);};
 const context=vm.createContext({$,accountBusy:false,passwordEnabled:true,passwordRegister:true,registrationPending:false,registrationStage:'',registrationFailed:false,passwordSubmissionVersion:0,materialLocked:()=>false,passwordFormProblem,passwordFeedback:{show:(text,options)=>feedback.push({text,options}),clear:()=>{}},profileMessage:text=>messages.push(text),profileLoginDestination:()=> 'overview',location:{search:''},registrationClient:{register:async()=>({user:{id:'test-id'}})},accountApi:async()=>({user:{id:'test-id'}}),updatePasswordControls:()=>{},applyAccount:()=>{},renderProfileAccount:()=>{},refreshAccess:async()=>({}),renderAccess:()=>{},loadMajorPreference:async()=>{},blank:()=>{},history:async()=>{},updatePhoneControls:()=>{},controls:()=>{},mode:'idle',reopenPendingClassroom:async()=>false,showProfile:()=>{},window:{location:{assign:()=>{}}},...overrides});
 vm.runInContext(submit,context);
 return {context,elements,$,feedback,messages,run:()=>$('password-form').onsubmit({preventDefault(){}})};
}
test('invalid submit produces an inline error, focuses its field and makes no registration request',async()=>{
 let requests=0;const f=setup({registrationClient:{register:async()=>{requests++;}}});f.$('login-password').value='abcdefgh';await f.run();
 assert.equal(requests,0);assert.equal(f.context.accountBusy,false);assert.equal(f.feedback.at(-1).options.field,'login-password');assert.equal(f.feedback.at(-1).options.focus,true);assert.match(f.feedback.at(-1).text,/两类/);
});
test('rapid repeated submits create only one registration operation',async()=>{
 let requests=0,resolve;const f=setup({registrationClient:{register:()=>{requests++;return new Promise(done=>resolve=done);}}});
 const first=f.run();await f.run();assert.equal(requests,1);resolve({user:{id:'test-id'}});await first;assert.equal(f.context.accountBusy,false);
});
test('server rejection leaves the form retryable and puts the reason next to the submit button',async()=>{
 const f=setup({registrationClient:{register:async()=>{throw new Error('这个账号已注册，请直接登录或换一个账号。');}}});await f.run();
 assert.equal(f.context.accountBusy,false);assert.equal(f.context.registrationFailed,true);assert.equal(f.feedback.at(-1).options.error,true);assert.equal(f.feedback.at(-1).options.focus,true);assert.match(f.feedback.at(-1).text,/已注册/);
});
test('history failure after a successful registration keeps the signed-in account and never offers another signup',async()=>{
 let signedIn,shown=false;const f=setup({applyAccount:user=>signedIn=user,history:async()=>{throw new Error('storage unavailable');},showProfile:()=>shown=true});await f.run();
 assert.equal(signedIn.id,'test-id');assert.equal(f.context.registrationFailed,false);assert.equal(f.context.accountBusy,false);assert.equal(shown,true);assert.match(f.messages.at(-1),/已成功登录/);assert.equal(f.$('login-password').value,'');
});
test('successful security actions release the navigation guard before opening the next page',async()=>{
 const security=readFileSync(new URL('../src/security-ui.js',import.meta.url),'utf8');
 const run=security.slice(security.indexOf(' async function run('),security.indexOf(" $('change-password-form').onsubmit"));
 let busyAtNavigation=true,redirect;
 const context=vm.createContext({busy:false,locked:()=>false,activeFeedback:null,formFeedback:()=>({show(){}}),setBusy:value=>busyAtNavigation=value,showMessage(){},profileMessage(){},fields:()=>({}),location:{assign:url=>{assert.equal(busyAtNavigation,false);redirect=url;}},form:{querySelectorAll:()=>[]}});
 await vm.runInContext(run+"\nrun(form,async()=>({redirect:'/profile?login=1&passwordChanged=1&next=security'}))",context);
 assert.equal(redirect,'/profile?login=1&passwordChanged=1&next=security');assert.equal(context.busy,false);
});

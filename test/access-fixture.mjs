import {environment,req} from './server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {loginMember} from '../src/member.js';
import {handle} from '../src/worker.js';
import {refreshAccess} from '../src/access.js';
export async function memberHandle(request,upstream){
 const {env}=environment();
 const account=await createVerifiedAccountSession(env,{provider:'phone',subject:'+8613800138000',label:'测试会员'});
 const cookie=account.cookie.split(';')[0];await loginMember(req('/api/member/login',{},cookie),env,'test-member-code');
 const headers=new Headers(request.headers);headers.set('Cookie',cookie);headers.set('X-Access-Mode','member');
 return handle(new Request(request,{headers}),upstream,env);
}
export async function activateClientMembership(){
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({member:true,sharedReady:true});
 try{await refreshAccess();}finally{globalThis.fetch=original;}
}

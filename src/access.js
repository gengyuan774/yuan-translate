import {TEXT_MODEL,TRANSCRIPTION_MODEL} from './models.js';
let member=false,paidMember=false,tier='none',trial=null,ready=false;
export function authHeaders(){return {'X-Access-Mode':'member'};}
export function getKey(){if(member&&ready)return 'member';throw new Error(member?'管理员尚未配置共享 API，请稍后再试。':'请先登录；新账号可免费翻译 1 小时，用完后可开通会员。');}
export function accessConfig(){return {hasKey:member&&ready,member,paidMember,tier,trial,sharedReady:ready,accessMode:member?'member':'none',transcriptionModel:TRANSCRIPTION_MODEL,textModel:TEXT_MODEL};}
async function memberApi(path,body){const res=await fetch('/api/member/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await res.json();if(!res.ok)throw new Error(data.error?.message||'会员服务暂不可用');return data;}
function updateAccess(data){member=!!data.member;paidMember=typeof data.paidMember==='boolean'?data.paidMember:member&&data.tier!=='trial';tier=data.tier||(paidMember?'regular':'none');trial=data.trial||null;ready=!!data.sharedReady;return accessConfig();}
export async function refreshAccess(){try{return updateAccess(await memberApi('status'));}catch{return updateAccess({});}}
export async function login(code){return updateAccess(await memberApi('login',{code}));}

export async function useMembership(){return refreshAccess();}

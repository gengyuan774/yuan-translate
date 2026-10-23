import {TEXT_MODEL,TRANSCRIPTION_MODEL} from './models.js';
let member=false,ready=false;
export function authHeaders(){return {'X-Access-Mode':'member'};}
export function getKey(){if(member&&ready)return 'member';throw new Error(member?'管理员尚未配置共享 API，请稍后再试。':'请先登录并开通会员');}
export function accessConfig(){return {hasKey:member&&ready,member,sharedReady:ready,accessMode:member?'member':'none',transcriptionModel:TRANSCRIPTION_MODEL,textModel:TEXT_MODEL};}
async function memberApi(path,body){const res=await fetch('/api/member/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await res.json();if(!res.ok)throw new Error(data.error?.message||'会员服务暂不可用');return data;}
export async function refreshAccess(){try{const data=await memberApi('status');member=data.member;ready=data.sharedReady;}catch{member=false;ready=false;}return accessConfig();}
export async function login(code){const data=await memberApi('login',{code});member=data.member;ready=data.sharedReady;return accessConfig();}

export async function useMembership(){return refreshAccess();}

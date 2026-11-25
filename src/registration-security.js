import {MemberError} from './errors.js';
import {usernameError} from './password-policy.js';

const COOKIE='__Host-classroom_signup',CHALLENGE_MS=5*60000,MIN_WAIT_MS=750,DIFFICULTY=18;
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const database=env=>{if(!env.DB)throw new MemberError('账户服务暂不可用，请稍后重试。',503);return env.DB;};
const invalid=()=>new MemberError('注册安全验证无效或已过期，请重新验证。',400);
const cookieValue=request=>request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);

export function registrationUsername(value){
 const username=typeof value==='string'?value.trim().toLowerCase():'';
 const error=usernameError(value);if(error)throw new MemberError(error,400);
 return username;
}
function ipv4(value){
 const parts=value.split('.');if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return null;
 return parts.map(Number);
}
function network(request){
 const value=(request.headers.get('CF-Connecting-IP')||'').trim().toLowerCase(),v4=ipv4(value);
 if(v4)return 'v4:'+v4.join('.');
 if(!value.includes(':')||!/^[a-f0-9:.]+$/.test(value))return 'unknown';
 let address=value;
 if(address.includes('.')){
  const last=address.lastIndexOf(':'),tail=ipv4(address.slice(last+1));if(!tail)return 'unknown';
  address=address.slice(0,last+1)+((tail[0]<<8)|tail[1]).toString(16)+':'+((tail[2]<<8)|tail[3]).toString(16);
 }
 const halves=address.split('::');if(halves.length>2)return 'unknown';
 const parse=half=>half?half.split(':'):[],left=parse(halves[0]),right=halves.length===2?parse(halves[1]):[];
 if([...left,...right].some(p=>!/^[a-f0-9]{1,4}$/.test(p)))return 'unknown';
 const missing=8-left.length-right.length;
 if(halves.length===1?missing!==0:missing<1)return 'unknown';
 const groups=[...left,...Array(missing).fill('0'),...right].map(p=>parseInt(p,16));
 if(groups.slice(0,5).every(n=>n===0)&&groups[5]===65535)return 'v4:'+[(groups[6]>>8)&255,groups[6]&255,(groups[7]>>8)&255,groups[7]&255].join('.');
 return 'v6:'+groups.slice(0,4).map(n=>n.toString(16)).join(':')+'::/64';
}
async function signingKey(env){
 const secret=env.MEMBER_SESSION_SECRET||env.OPENAI_API_KEY;
 if(typeof secret!=='string'||!secret)throw new MemberError('账户安全服务暂不可用，请稍后重试。',503);
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
}
async function identities(request,env,username){
 const key=await signingKey(env),mac=async value=>hex(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
 return {networkHash:await mac('network:'+network(request)),identityHash:await mac('username:'+username),browserHash:async value=>mac('browser:'+value)};
}

export async function authRate(request,env,action,username){
 if(!['challenge','register','login'].includes(action))throw new MemberError('账户安全参数不正确。',400);
 const normalized=registrationUsername(username),now=Date.now(),db=database(env);
 await db.prepare('DELETE FROM auth_attempts WHERE id IN (SELECT id FROM auth_attempts WHERE created_at<=? ORDER BY created_at LIMIT 100)').bind(now-86400000).run();
 await db.prepare('DELETE FROM registration_challenges WHERE id IN (SELECT id FROM registration_challenges WHERE expires_at<=? ORDER BY expires_at LIMIT 100)').bind(now).run();
 const ids=await identities(request,env,normalized),conditions=[],args=[];
 const rule=(clause,values,period,limit)=>{conditions.push(`(SELECT COUNT(*) FROM auth_attempts WHERE action=? AND created_at>?${clause})<?`);args.push(action,now-period,...values,limit);};
 if(action==='register'){
  rule(' AND network_hash=?',[ids.networkHash],3600000,3);
  rule(' AND network_hash=?',[ids.networkHash],86400000,10);
  rule(' AND identity_hash=?',[ids.identityHash],3600000,5);
  rule('',[],3600000,100);
 }else if(action==='login'){
  rule(' AND network_hash=?',[ids.networkHash],600000,20);
  rule(' AND network_hash=? AND identity_hash=?',[ids.networkHash,ids.identityHash],600000,10);
  rule(' AND identity_hash=?',[ids.identityHash],600000,50);
  rule('',[],600000,200);
 }else{
  rule(' AND network_hash=?',[ids.networkHash],600000,20);
  rule('',[],600000,1000);
 }
 const accepted=await database(env).prepare(`INSERT INTO auth_attempts(id,action,network_hash,identity_hash,created_at) SELECT ?,?,?,?,? WHERE ${conditions.join(' AND ')} RETURNING id`).bind(crypto.randomUUID(),action,ids.networkHash,ids.identityHash,now,...args).first();
 if(!accepted)throw new MemberError('注册或登录尝试过于频繁，请稍后再试。',429);
 return ids;
}

export async function createRegistrationChallenge(request,env,data){
 const username=registrationUsername(data?.username);
 if(data?.website!==undefined&&(typeof data.website!=='string'||data.website!==''))throw invalid();
 const ids=await authRate(request,env,'challenge',username),id=crypto.randomUUID(),nonce=random(),browser=random(),now=Date.now(),expiresAt=now+CHALLENGE_MS;
 await database(env).prepare('INSERT INTO registration_challenges(id,nonce,network_hash,username_hash,browser_hash,created_at,expires_at,claimed_at) VALUES(?,?,?,?,?,?,?,NULL)').bind(id,nonce,ids.networkHash,ids.identityHash,await ids.browserHash(browser),now,expiresAt).run();
 return {data:{challengeId:id,nonce,difficulty:DIFFICULTY,expiresAt,minWaitMs:MIN_WAIT_MS},cookie:`${COOKIE}=${browser}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`};
}

export async function consumeRegistrationChallenge(request,env,username,registration,website){
 if(website!==undefined&&(typeof website!=='string'||website!==''))throw invalid();
 const browser=cookieValue(request),id=registration?.challengeId;
 if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||! /^[a-f0-9]{64}$/.test(browser||''))throw invalid();
 const ids=await identities(request,env,registrationUsername(username)),now=Date.now();
 // Claim only the bound browser's challenge. A failed proof or an early
 // attempt consumes it; another browser cannot invalidate somebody else's.
 const row=await database(env).prepare('UPDATE registration_challenges SET claimed_at=? WHERE id=? AND claimed_at IS NULL AND network_hash=? AND username_hash=? AND browser_hash=? RETURNING nonce,created_at,expires_at').bind(now,id,ids.networkHash,ids.identityHash,await ids.browserHash(browser)).first();
 if(!row||row.expires_at<=now||now-row.created_at<MIN_WAIT_MS)throw invalid();
 const solution=registration?.solution;
 if(!Number.isInteger(solution)||solution<0||solution>0xffffffff)throw invalid();
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(`${id}:${row.nonce}:${solution}`)));
 if(digest[0]!==0||digest[1]!==0||(digest[2]&0xc0)!==0)throw invalid();
}

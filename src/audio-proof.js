import {MemberError} from './errors.js';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const PROOF_MS=20*60000;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const hash=async source=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(source)));
const bucket=id=>'trial-translation:'+id;
const invalid=()=>new MemberError('录音片段凭证无效或已过期，请重新录音。',401);
async function key(env){
 const secret=env.MEMBER_SESSION_SECRET||env.OPENAI_API_KEY;
 if(typeof secret!=='string'||!secret)throw new MemberError('免费翻译服务暂不可用，请稍后重试。',503);
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
function encodePayload(payload){return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(payload)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodePayload(value){
 if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length>2048)throw invalid();
 try{return JSON.parse(decoder.decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0))));}catch{throw invalid();}
}
async function audioRow(env,accountId,id){
 return env.DB.prepare("SELECT id,created_at FROM service_requests WHERE id=? AND account_id=? AND kind='audio' AND state IN ('completed','compensated') AND audio_ms>0").bind(id,accountId).first();
}

export async function issueAudioProof(env,accountId,rowId,source){
 if(typeof accountId!=='string'||!accountId||!uuid(rowId)||typeof source!=='string'||!source.trim())throw new MemberError('录音片段参数不正确。',400);
 if(!env.DB)throw new MemberError('免费翻译服务暂不可用，请稍后重试。',503);
 const row=await audioRow(env,accountId,rowId);
 if(!row||!Number.isSafeInteger(row.created_at)||row.created_at+PROOF_MS<=Date.now())throw invalid();
 // The audio request owns one fixed deadline. Reissuing the same receipt can
 // never create a new time window after its retry counter has been cleaned up.
 const payload=encodePayload({accountId,id:rowId,hash:await hash(source),expiresAt:row.created_at+PROOF_MS});
 return payload+'.'+hex(await crypto.subtle.sign('HMAC',await key(env),encoder.encode(payload)));
}

export async function verifyTrialTranslation(env,member,data){
 if(member?.tier!=='trial')return;
 const proofs=data?.sourceProofs;
 if(!Array.isArray(proofs)||proofs.length<1)throw new MemberError('免费翻译仅支持已完成的实时录音片段，请先开始录音。',402);
 if(proofs.length>30||proofs.some(p=>!p||typeof p.source!=='string'||!p.source.trim()||typeof p.proof!=='string'))throw new MemberError('录音片段凭证格式不正确。',400);
 const source=proofs.map(p=>p.source).join(' ');
 if(data.translationSource!==source||typeof data.input!=='string'||!data.input.endsWith('\n当前片段：'+source))throw new MemberError('翻译内容与录音片段不一致，请重新提交。',400);
 if(!env.DB)throw new MemberError('免费翻译服务暂不可用，请稍后重试。',503);
 const signingKey=await key(env),now=Date.now(),verified=[];
 for(const item of proofs){
  const parts=item.proof.split('.');
  if(parts.length!==2||!/^[a-f0-9]{64}$/.test(parts[1]))throw invalid();
  const payload=decodePayload(parts[0]),signature=Uint8Array.from(parts[1].match(/../g),b=>parseInt(b,16));
  if(!await crypto.subtle.verify('HMAC',signingKey,signature,encoder.encode(parts[0]))||payload?.accountId!==member.accountId||!uuid(payload.id)||!Number.isSafeInteger(payload.expiresAt)||payload.expiresAt<=now||payload.hash!==await hash(item.source))throw invalid();
  if(verified.some(p=>p.id===payload.id))throw new MemberError('同一录音片段不能重复提交。',400);
  const row=await audioRow(env,member.accountId,payload.id);
  if(!row||!Number.isSafeInteger(row.created_at)||payload.expiresAt!==row.created_at+PROOF_MS)throw invalid();
  verified.push(payload);
 }
 const admittedAt=Date.now();if(verified.some(p=>p.expiresAt<=admittedAt))throw invalid();
 const marker='trial-translation-authorization:'+crypto.randomUUID(),placeholders=verified.map(()=>'?').join(','),ids=verified.map(p=>p.id),keys=verified.map(p=>bucket(p.id));
 // One D1 transaction admits every receipt or none. The private marker belongs
 // to this authorization only, so racing Workers cannot partially spend a set.
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO usage_buckets (id,count,expires_at)
   SELECT ?,1,? WHERE (SELECT COUNT(*) FROM service_requests WHERE account_id=? AND id IN (${placeholders}) AND kind='audio' AND state IN ('completed','compensated') AND audio_ms>0 AND created_at>?)=?
   AND NOT EXISTS(SELECT 1 FROM usage_buckets WHERE id IN (${placeholders}) AND count>=3)`).bind(marker,admittedAt+120000,member.accountId,...ids,admittedAt-PROOF_MS,verified.length,...keys),
  ...verified.map(p=>env.DB.prepare(`INSERT INTO usage_buckets (id,count,expires_at) SELECT ?,1,? WHERE EXISTS(SELECT 1 FROM usage_buckets WHERE id=?)
   ON CONFLICT(id) DO UPDATE SET count=usage_buckets.count+1`).bind(bucket(p.id),p.expiresAt,marker))
 ]);
 const admitted=await env.DB.prepare('SELECT count FROM usage_buckets WHERE id=?').bind(marker).first();
 if(!admitted)throw new MemberError('录音片段的翻译重试次数已用完，请继续录音或开通会员。',402);
 await env.DB.prepare('DELETE FROM usage_buckets WHERE id=?').bind(marker).run();
}

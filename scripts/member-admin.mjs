// Administrative CLI. The credential stays in an ignored local file, never in arguments or output.
import {readFileSync} from 'node:fs';
const [username,tier,expiresAt,reason]=process.argv.slice(2);
if(!username){console.error('Usage: node scripts/member-admin.mjs username [regular|premium|none ISO-UTC-expiry reason]');process.exit(1);}
const secret=readFileSync(new URL('../.env.member-admin',import.meta.url),'utf8').match(/^MEMBER_ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
if(!secret)throw new Error('Local administrator credential missing');
const url='https://classroom-notes-gengyuan.xiangyuguan.chatgpt.site/api/admin/membership';
const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json'};
async function call(endpoint,options={}){
 const response=await fetch(endpoint,{...options,headers,redirect:'error',signal:AbortSignal.timeout(30000)});
 const body=await response.json();if(!response.ok)throw new Error('HTTP '+response.status+': '+(body.error?.message||'Request failed'));return body;
}
const before=await call(url+'?username='+encodeURIComponent(username));
if(!tier){console.log(JSON.stringify(before));process.exit(0);}
if(!reason)throw new Error('A reason is required');
const changed=await call(url,{method:'PUT',body:JSON.stringify({username:before.username,accountId:before.accountId,tier,expiresAt:tier==='none'?null:expiresAt,expectedUpdatedAt:before.updatedAt,reason})});
const verified=await call(url+'?username='+encodeURIComponent(username));
if(verified.tier!==changed.tier||verified.expiresAt!==changed.expiresAt||verified.updatedAt!==changed.updatedAt)throw new Error('Read-back verification failed');
console.log(JSON.stringify({verified:true,...changed}));

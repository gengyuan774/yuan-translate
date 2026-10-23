import {readFileSync} from 'node:fs';
const [username,action,reason,reference,outcome]=process.argv.slice(2);
if(!username)throw new Error('Usage: node scripts/account-admin.mjs username [block|unblock|refund_note reason reference outcome]; or --deletions [jobId]');
const secret=readFileSync(new URL('../.env.member-admin',import.meta.url),'utf8').match(/^MEMBER_ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];if(!secret)throw new Error('Administrator credential missing');
const origin='https://classroom-notes-gengyuan.xiangyuguan.chatgpt.site';
async function call(path,body){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'Request failed');return data;}
if(username==='--deletions'){console.log(JSON.stringify(action?await call('/api/admin/deletion/resume',{jobId:action}):await call('/api/admin/deletions')));process.exit(0);}
const before=await call('/api/admin/security?username='+encodeURIComponent(username));
if(!action){console.log(JSON.stringify(before));process.exit(0);}
console.log(JSON.stringify(await call('/api/admin/security',{username:before.username,accountId:before.accountId,expectedVersion:before.version,action,reason,reference,outcome})));

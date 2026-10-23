// Existing administrator credential stays local; it is never passed to a browser.
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const [command='status',...args]=process.argv.slice(2);
const secret=readFileSync(new URL('../.env.member-admin',import.meta.url),'utf8').match(/^MEMBER_ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
if(!secret)throw Error('Local administrator credential missing');
const origin=process.env.SERVICE_ADMIN_ORIGIN||'https://www.yuantranslate.com';
if(new URL(origin).protocol!=='https:'&& !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))throw Error('Use HTTPS');
async function api(path,body){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw Error(d.error?.message||'Request failed');return d;}
if(command==='open'){
 const {ticket}=await api('/api/admin/cost-session',{});const url=origin+'/admin/usage#ticket='+encodeURIComponent(ticket);
 const app=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
 const child=spawn(app,[url],{stdio:'ignore',shell:false});await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Cannot open browser')));});console.log('已打开管理页面。入口一次有效，会话 30 分钟。');
}else if(command==='status'){console.log(JSON.stringify(await api('/api/admin/costs'+(args[0]?'?username='+encodeURIComponent(args[0]):'')),null,2));}
else if(command==='budget'||command==='pause'||command==='resume'){
 const {budget}=await api('/api/admin/costs');
 const data={warningCents:budget.warningCents,hardCents:budget.hardCents,paused:budget.paused,expectedRevision:budget.revision};
 if(command==='budget'){data.warningCents=args[0]==='off'?null:Math.round(Number(args[0])*100);data.hardCents=args[1]==='off'?null:Math.round(Number(args[1])*100);data.reason=args.slice(2).join(' ');}
 else{data.paused=command==='pause';data.reason=args.join(' ');}
 console.log(JSON.stringify(await api('/api/admin/costs/settings',data),null,2));
}else throw Error('Usage: node scripts/usage-admin.mjs open | status [username] | budget 预警元 上限元 原因 | pause 原因 | resume 原因');

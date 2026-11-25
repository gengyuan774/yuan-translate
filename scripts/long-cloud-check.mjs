// Metadata-only readback of this test's synthetic classrooms. No class bodies,
// passwords, service keys or administrator credentials enter the report.
import {readFile,writeFile} from 'node:fs/promises';
import {loadAdminConfig} from './admin-config.mjs';
const [output,...reports]=process.argv.slice(2);if(!output||!reports.length)throw Error('Output JSON and acceptance report paths required.');
const {origin,secret}=loadAdminConfig();
async function api(path){const r=await fetch(origin+path,{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(60000)});const data=await r.json();return {status:r.status,data};}
const all=await api('/api/admin/costs');if(all.status!==200)throw Error('Administrator read failed: '+all.status);
const candidates=all.data.accounts.filter(a=>/^qa_long_[a-z0-9]+$/.test(a.username));
const observations=[];
for(const path of reports){
 const test=JSON.parse(await readFile(path,'utf8'));if(test.origin!==origin)throw Error('Acceptance origin mismatch.');
 for(const account of candidates){
  const read=await api('/api/admin/history/check?username='+encodeURIComponent(account.username)+'&classId='+encodeURIComponent(test.classId));
  if(read.status===404)continue;if(read.status!==200)throw Error('Cloud metadata check failed: '+read.status);
  observations.push({report:path,checkedAt:new Date().toISOString(),elapsedMinutes:test.elapsedMinutes,...read.data});break;
 }
}
await writeFile(output,JSON.stringify({origin,observations},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(observations.map(x=>({report:x.report,minutes:x.elapsedMinutes,objectStatus:x.objectStatus,segments:x.segments,translatedSegments:x.translatedSegments,status:x.status}))));

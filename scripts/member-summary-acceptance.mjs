// Live acceptance against the configured site, using only a disposable QA account.
import 'fake-indexeddb/auto';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {solveRegistrationProof} from '../src/registration-proof-worker.js';
import {setAccount,saveSession,saveMaterial,sessionSyncPending,clearLocalAccount} from '../src/storage.js';
import {refreshAccess,getKey} from '../src/access.js';
import {translateSegment} from '../src/core.js';
import {localApi} from '../src/local-api.js';

const [origin,reportPath]=process.argv.slice(2);
const config=await readFile(new URL('../.env.long-member-code',import.meta.url),'utf8');
if(config.match(/^SERVICE_ORIGIN=(\S+)$/m)?.[1]!==origin)throw Error('Membership code is bound to another site.');
const code=config.match(/^MEMBER_LONG_CODE=(\S+)$/m)?.[1];if(!code||!reportPath)throw Error('Code configuration and report path required.');
const nativeFetch=fetch,cookies=new Map(),jar=()=>[...cookies].map(([k,v])=>k+'='+v).join('; '),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const username='qa_member_'+Date.now().toString(36),password=randomBytes(24).toString('base64url')+'!9';
const report={origin,startedAt:new Date().toISOString(),checks:[],workload:'Live membership redemption and OpenAI summary; synthetic course text and extracted reference documents; no physical microphone'};
const check=(pass,name)=>{report.checks.push({name,pass:!!pass});if(!pass)throw Error(name);console.log(JSON.stringify({pass:true,name}));};
async function api(path,body){const r=await nativeFetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:jar(),'Content-Type':'application/json','X-Access-Mode':'member'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});for(const v of r.headers.getSetCookie()){const p=v.split(';')[0],i=p.indexOf('=');cookies.set(p.slice(0,i),p.slice(i+1));}return {status:r.status,data:await r.json()};}
let user;
try{
 const challenge=await api('/api/account/register/challenge',{username});check(challenge.status===200,'Registration challenge');const solution=solveRegistrationProof(challenge.data);await sleep(challenge.data.minWaitMs);
 const account=await api('/api/account/register/password',{username,password,registration:{challengeId:challenge.data.challengeId,solution}});user=account.data.user;report.registrationStatus=account.status;if(account.status!==200)report.registrationError=account.data.error?.message;check(account.status===200&&!!user?.id,'Disposable account registration'+(account.status===200?'':' ('+account.status+': '+String(account.data.error?.message||'')+')'));
 const snapshot={title:'Synthetic economics acceptance',major:{code:'economics'},warnings:[],segments:[{offset:0,source:'The consumer price index rose by two percent. Opportunity cost is the value of the next best alternative.'}],materials:[]};
 check((await api('/api/service/summary',{id:crypto.randomUUID(),snapshot})).status===402,'Free trial cannot generate paid summaries');
 const first=await api('/api/member/login',{code});check(first.status===200&&first.data.membership?.tier==='premium'&&first.data.membership.expiresAt===Date.parse('2099-12-31T23:59:59.999+08:00'),'Long code grants gold through 2099');
 check((await api('/api/member/login',{code})).status===409,'The same account cannot redeem twice');
 globalThis.location={href:origin+'/',protocol:'https:'};
 const sentSnapshots=[];
 globalThis.fetch=async(path,options={})=>{const url=new URL(path,origin);if(url.origin!==origin)throw Error('Unexpected origin');if(url.pathname==='/api/service/summary')sentSnapshots.push(JSON.parse(options.body).snapshot);const headers=new Headers(options.headers);headers.set('Cookie',jar());headers.set('Origin',origin);return nativeFetch(url,{...options,headers});};
 setAccount(user);await refreshAccess();let session=await localApi('/api/sessions',{method:'POST',body:JSON.stringify({title:'自动验收 · 会员与参考资料',sourceLanguage:'en'})});
 const selected=crypto.randomUUID(),unselected=crypto.randomUUID();
 for(const [id,name,text] of [[selected,'economics-selected.pptx','CPI means Consumer Price Index. Opportunity cost is the next best alternative forgone.'],[unselected,'unselected-secret-note.txt','EXCLUDED_QA_MARKER: The fictional club password is purple-lemon-2099.']])await saveMaterial(session.id,{id,name,characters:text.length,pageCount:1,warnings:[],pages:[{label:'第 1 页',text}]});
 session.materials=[{id:selected,name:'economics-selected.pptx',enabled:true,pageCount:1,characters:100,warnings:[]},{id:unselected,name:'unselected-secret-note.txt',enabled:false,pageCount:1,characters:100,warnings:[]}];
 session.segments=snapshot.segments.map(s=>({...s,id:crypto.randomUUID(),translation:'消费者价格指数上涨了百分之二。机会成本是放弃的最佳替代方案的价值。'}));await saveSession(session);
 session=await localApi('/api/sessions/'+session.id+'/summary',{method:'POST'});
 check(session.summary?.length>40&&/[\u4e00-\u9fff]/.test(session.summary),'Live OpenAI generates a readable Chinese course summary');
 check(sentSnapshots.length===1&&sentSnapshots[0].materials.length===1&&sentSnapshots[0].materials[0].id===selected&&!JSON.stringify(sentSnapshots[0]).includes('EXCLUDED_QA_MARKER'),'Only the selected reference is submitted');
 check(session.summarySources?.length===1&&session.summarySources[0].id===selected&&!session.summary.includes('EXCLUDED_QA_MARKER'),'Returned references exclude unchecked material');
 const before=(await api('/api/account/usage')).data;
 await localApi('/api/sessions/'+session.id+'/summary',{method:'POST'});const after=(await api('/api/account/usage')).data;
 check(before.summariesUsed===after.summariesUsed,'Identical summary retry does not consume a second summary');
 const end=Date.now()+60000;while(await sessionSyncPending(session.id)){if(Date.now()>end)throw Error('Cloud sync timeout');await sleep(500);}
 const reopened=(await api('/api/history/'+session.id)).data.session;check(reopened?.summary===session.summary&&reopened.segments.length===session.segments.length,'Direct cloud read preserves summary and subtitles');
 report.termTranslations=[];
 for(const [major,source] of [
  ['engineering','The CPU reads data from RAM, while the PLC controls the motor. The sampling frequency is 1 kHz.'],
  ['accounting','ROE is return on equity, and EBITDA is earnings before interest, taxes, depreciation and amortization.'],
  ['computer','In machine learning, PCA means principal component analysis. We use SQL to query the database.']
 ]){
  const result=await translateSegment({...session,title:'专业术语验收',major:{code:major},segments:[],materials:[]},getKey(),source);
  check(typeof result.translation==='string'&&/[\u4e00-\u9fff]/.test(result.translation),'Live '+major+' terminology translation returned');report.termTranslations.push({major,source,translation:result.translation});
 }
 report.usageBeforeRetry=before;report.usageAfterRetry=after;report.summary=session.summary;report.complete=true;
}catch(error){report.complete=false;report.error=String(error.message).replace(/sk-[\w-]+/g,'[redacted]');process.exitCode=1;console.log(JSON.stringify({failure:report.error}));}
finally{
 globalThis.fetch=nativeFetch;try{await clearLocalAccount();}catch{}setAccount(null);
 if(user)try{const receipt=await api('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'});if(receipt.status!==200)throw Error('Deletion request failed');for(let i=0;i<30;i++){const r=await api('/api/account/deletion/resume',receipt.data);if(r.data.status==='completed'){report.testDataDeleted=true;break;}await sleep((r.data.retryAfter||5)*1000);}}catch(error){report.cleanupError=String(error.message);}
 report.endedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({complete:report.complete,testDataDeleted:report.testDataDeleted,reportPath}));
}

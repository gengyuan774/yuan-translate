// Real wall-clock, real provider acceptance test. Creates and deletes only its own
// synthetic account. Never reads the production API key or browser credentials.
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import 'fake-indexeddb/auto';
import {solveRegistrationProof} from '../src/registration-proof-worker.js';
import {BrowserLive} from '../src/live.js';
import {localApi} from '../src/local-api.js';
import {setAccount,getSession,sessionSyncPending,clearLocalAccount} from '../src/storage.js';
import {refreshAccess} from '../src/access.js';

const [origin,audioPath,secondAudioPath,reportPath,minutes='125']=process.argv.slice(2);
if(!origin?.startsWith('https://')||!audioPath||!secondAudioPath||!reportPath)throw Error('Arguments: https-origin pcm-wav pcm-wav report-json [minutes]');
const duration=Number(minutes)*60000;
if(!Number.isFinite(duration)||duration<60000||duration>180*60000)throw Error('Duration must be 1–180 minutes');
const username='qa_long_'+Date.now().toString(36),password=randomBytes(24).toString('base64url')+'!9';
const cookies=new Map(),jar=()=>[...cookies].map(([k,v])=>k+'='+v).join('; ');
const nativeFetch=globalThis.fetch,NativeSocket=globalThis.WebSocket;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={startedAt:new Date().toISOString(),origin,workload:'Actual BrowserLive client and live API, synthetic speech every 30 seconds; no physical microphone or mobile browser',targetMinutes:Number(minutes),checks:[],events:[],socketConnections:0,utterances:0};
report.clientSources=Object.fromEntries(await Promise.all(['live.js','core.js','transcript-merge.js','connection-recovery.js'].map(async name=>[name,createHash('sha256').update(await readFile(new URL('../src/'+name,import.meta.url))).digest('hex')])));
const clean=v=>String(v).replace(/sk-[\w-]+/g,'[redacted]').slice(0,300);
async function save(){await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
function log(type,detail={}){const entry={at:new Date().toISOString(),type,...detail};report.events.push(entry);console.log(JSON.stringify(entry));}
function check(ok,name){report.checks.push({name,pass:!!ok,at:new Date().toISOString()});if(!ok)throw Error(name);log('pass',{name});}
async function api(path,body){const r=await nativeFetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:jar(),'Content-Type':'application/json','X-Access-Mode':'member'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}const data=await r.json();if(!r.ok)throw Error('API '+path+' '+r.status+': '+clean(data.error?.message));return data;}
async function pcm(path){const wav=await readFile(path);for(let p=12;p+8<=wav.length;){const n=wav.readUInt32LE(p+4);if(wav.toString('ascii',p,p+4)==='data')return wav.subarray(p+8,p+8+n);p+=8+n+(n%2);}throw Error('No WAV PCM data');}
let live,user,finished,fatal='',expectedIdle=false,idleSeen=false,recovered=0,progress,stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function until(predicate,label,ms=90000){const end=Date.now()+ms;while(!predicate()){if(fatal||stopping)throw Error(fatal||'Test interrupted');if(Date.now()>end)throw Error('Timeout: '+label);await sleep(100);} }
try{
 const challenge=await api('/api/account/register/challenge',{username}),solution=solveRegistrationProof(challenge);await sleep(challenge.minWaitMs);
 ({user}=await api('/api/account/register/password',{username,password,registration:{challengeId:challenge.challengeId,solution}}));check(!!user?.id,'Synthetic registration');
 globalThis.location={href:origin+'/',protocol:'https:'};
 globalThis.fetch=async(path,options={})=>{const url=new URL(path,origin);if(url.origin!==origin)throw Error('Unexpected test origin');const headers=new Headers(options.headers);headers.set('Cookie',jar());headers.set('Origin',origin);return nativeFetch(url,{...options,headers});};
 globalThis.WebSocket=class extends NativeSocket{constructor(url){super(url,{headers:{Cookie:jar(),Origin:origin}});report.socketConnections++;log('socket_created',{number:report.socketConnections});}};
 setAccount(user);await refreshAccess();report.usageBefore=await api('/api/account/usage');
 const session=await localApi('/api/sessions',{method:'POST',body:JSON.stringify({title:'自动验收 · 两小时课堂',sourceLanguage:'en'})});report.classId=session.id;
 live=new BrowserLive();live.onmessage=({data})=>{const e=JSON.parse(data);if(e.type==='fatal')fatal=e.message;if(e.type==='finished')finished=e;if(e.type==='idle'){idleSeen=true;if(!expectedIdle)fatal='Unexpected idle pause';}if(e.type==='recovered')recovered++;if(['fatal','warning','recovering','recovered','idle','ready'].includes(e.type))log(e.type,{message:clean(e.message||'')});};
 await live.command({type:'start',id:session.id});await until(()=>!live.paused,'start');
 const recordings=await Promise.all([pcm(audioPath),pcm(secondAudioPath)]),silent=Buffer.alloc(4800);
 async function utterance(){await until(()=>!live.paused&&!live.renewing,'recording available');const data=recordings[report.utterances%recordings.length];report.utterances++;for(let i=0;i<data.length;i+=4800){const chunk=data.subarray(i,i+4800);live.send(chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength));await sleep(chunk.length/48);}for(let i=0;i<15;i++){live.send(silent.buffer.slice(silent.byteOffset,silent.byteOffset+silent.byteLength));await sleep(100);} }
 const started=Date.now();report.recordingStartedAt=new Date(started).toISOString();
 progress=setInterval(()=>{report.elapsedMinutes=(Date.now()-started)/60000;report.segmentCount=live.session.segments.length;report.translatedCount=live.session.segments.filter(s=>s.translation?.trim()).length;report.memoryMb=Math.round(process.memoryUsage().rss/1024/1024);log('progress',{minutes:+report.elapsedMinutes.toFixed(2),segments:report.segmentCount,translated:report.translatedCount,sockets:report.socketConnections});void save();},60000);
 while(Date.now()-started<duration){const next=Date.now()+30000;await utterance();if(fatal||stopping)throw Error(fatal||'Test interrupted');await sleep(Math.max(0,next-Date.now()));}
 report.activeDurationMs=Date.now()-started;check(report.activeDurationMs>=duration,'Requested real elapsed class duration');
 if(duration>=112*60000)check(report.socketConnections>=3,'Both 55-minute connection renewals occurred');
 await until(()=>live.pending===0&&live.jobs.size===0,'translations before network fault');const beforeCount=live.session.segments.length;
 live.upstream.close();await until(()=>recovered>0&&!live.renewing,'real closed transport automatically reconnects');await utterance();await until(()=>live.session.segments.length>beforeCount&&live.session.segments.at(-1).translation?.trim(),'translation after reconnect');check(true,'Real transport interruption resumes same class with new translation');
 expectedIdle=true;const lastTranscript=live.lastTranscriptAt;await until(()=>idleSeen,'ten minute no speech pause',11*60000);check(live.paused&&Date.now()-lastTranscript>=600000,'Ten real minutes without speech pauses');
 await live.command({type:'resume'});await until(()=>!live.paused,'resume after idle');await utterance();
 await live.command({type:'finish',autoSummary:false});await until(()=>finished,'finish',120000);check(finished.session.status==='completed','Finish saves the same class');
 await until(()=>live.jobs.size===0,'translation queue');
 const syncEnd=Date.now()+60000;while(await sessionSyncPending(session.id)){if(Date.now()>syncEnd)throw Error('Final cloud sync timeout');await sleep(500);}
 const saved=await getSession(session.id);check(saved.segments.length===live.session.segments.length,'Cloud reopen retains all segments');check(saved.segments.every(s=>s.source?.trim()&&s.translation?.trim()&&!s.error),'All committed turns have source and translation');
 check(new Set(saved.segments.map(s=>s.id)).size===saved.segments.length,'No duplicate segment IDs');report.usageAfter=await api('/api/account/usage');report.finalSegmentCount=saved.segments.length;report.complete=true;
}catch(error){report.complete=false;report.error=clean(error.message);log('failure',{message:report.error});process.exitCode=1;}
finally{
 clearInterval(progress);live?.close();globalThis.fetch=nativeFetch;globalThis.WebSocket=NativeSocket;
 try{await clearLocalAccount();}catch{}setAccount(null);
 if(user){try{const receipt=await api('/api/account/delete',{currentPassword:password,confirmation:'注销并删除'});for(let i=0;i<30;i++){const result=await api('/api/account/deletion/resume',receipt);if(result.status==='completed'){report.testDataDeleted=true;break;}await sleep((result.retryAfter||5)*1000);}log('cleanup',{deleted:report.testDataDeleted===true});}catch(error){report.cleanupError=clean(error.message);log('cleanup_failed',{message:report.cleanupError});}}
 report.endedAt=new Date().toISOString();await save();console.log(JSON.stringify({complete:report.complete,reportPath,activeDurationMs:report.activeDurationMs,segments:report.finalSegmentCount,testDataDeleted:report.testDataDeleted}));
}

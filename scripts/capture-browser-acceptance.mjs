// Local-only browser fixture: real AudioContext/AudioWorklet and application UI,
// synthetic microphone and provider. Never shipped in the public asset directory.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {environment} from '../test/server-fixture.mjs';
import {createVerifiedAccountSession} from '../src/account-server.js';
import {handle} from '../src/worker.js';
const f=environment();delete f.env.MEMBER_DAILY_TEXT_LIMIT;
const a=await createVerifiedAccountSession(f.env,{provider:'email',subject:'capture-browser@example.test',label:'本机录音模拟验收'}),cookie=a.cookie.split(';')[0];
f.sql.prepare("UPDATE account_memberships SET tier='regular',expires_at=?,updated_at=?,quota_anchor=? WHERE account_id=?").run(Date.now()+86400000,Date.now(),Date.now(),a.user.id);
const objects=new Map();f.env.BUCKET={put:async(k,v)=>objects.set(k,v),get:async k=>objects.has(k)?{json:async()=>JSON.parse(objects.get(k))}:null,delete:async k=>objects.delete(k)};
const originalBatch=f.env.DB.batch.bind(f.env.DB);let serial=Promise.resolve();f.env.DB.batch=items=>{const run=serial.then(()=>originalBatch(items));serial=run.catch(()=>{});return run;};
const fixture=await readFile(new URL('../test/capture-browser-fixture.js',import.meta.url),'utf8');
const provider=async(_url,options)=>{
 const body=JSON.parse(options.body),text='机会成本是放弃的最佳替代方案的价值。';
 if(body.stream){const id=crypto.randomUUID();return new Response('event: response.output_text.delta\ndata: '+JSON.stringify({type:'response.output_text.delta',delta:text})+'\n\nevent: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id,status:'completed',output:[{content:[{type:'output_text',text}]}],usage:{input_tokens:50,output_tokens:20}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});}
 return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'## 课堂概览\n'+text}]}],usage:{input_tokens:50,output_tokens:20}});
};
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/qa-capture.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(fixture);return;}
  const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks),headers=new Headers(req.headers);headers.set('Cookie',cookie);headers.set('CF-Connecting-IP','198.51.100.44');
  const response=await handle(new Request('http://'+req.headers.host+req.url,{method:req.method,headers,...(body.length?{body}:{})}),provider,f.env);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.headers.get('Content-Type')?.includes('text/html'))res.end((await response.text()).replace('<script type="module" src="/app.js"></script>','<script src="/qa-capture.js"></script><script type="module" src="/app.js"></script>'));
  else res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){console.error(error.message);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Local fixture failed'}}));}
});
server.listen(0,'127.0.0.1',()=>console.log('Local capture fixture: http://localhost:'+server.address().port));

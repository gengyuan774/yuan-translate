import {readFileSync,statSync,writeFileSync} from 'node:fs';
const [command='list',id,arg,reason,requestId]=process.argv.slice(2);
const usage='Usage: node scripts/payment-admin.mjs list [before]; get ORDER; reconcile ORDER "reason"; refund ORDER CENTS "reason" UUID; refund-query ORDER REFUND_ID "reason"; export ABSOLUTE.csv';
if(!['list','get','reconcile','refund','refund-query','export'].includes(command))throw new Error(usage);
if(['get','reconcile','refund','refund-query'].includes(command)&&!/^[a-f0-9]{32}$/.test(id||''))throw new Error(usage);
if(command==='reconcile'&&!arg?.trim()||['refund','refund-query'].includes(command)&&!reason?.trim())throw new Error('An operation reason is required. '+usage);
if(command==='refund'&&(!/^[1-9]\d*$/.test(arg||'')||!Number.isSafeInteger(Number(arg))||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId||'')))throw new Error('Refund amount is integer CNY cents. Reuse the SAME request UUID after a timeout. '+usage);
const secretFile=new URL('../.env.member-admin',import.meta.url);
if(statSync(secretFile).mode&0o077)throw new Error('Administrator credential file must have mode 600.');
const secret=readFileSync(secretFile,'utf8').match(/^MEMBER_ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
if(!secret)throw new Error('Administrator credential missing');
const origin='https://classroom-notes-gengyuan.xiangyuguan.chatgpt.site';
async function call(path,body){
 const r=await fetch(origin+'/api/admin/payments'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(60000)});
 const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'Payment operation failed; check the order before retrying.');return data;
}
if(command==='export'){
 if(!id?.startsWith('/'))throw new Error('Provide an absolute CSV output path. '+usage);
 const fields=['id','accountId','tier','amount','currency','state','refundedAmount','createdAt','paidAt','grantStart','grantEnd','reviewReason'];
 const csv=value=>'"'+String(value??'').replaceAll('"','""').replace(/^[=+@\t\r-]/,"'$&")+'"';
 const lines=[fields.map(csv).join(',')];let before=null;
 do{const page=await call(before?'?before='+before:'');for(const order of page.orders)lines.push(fields.map(k=>csv(order[k])).join(','));before=page.next;}while(before);
 writeFileSync(id,'\uFEFF'+lines.join('\r\n')+'\r\n',{encoding:'utf8',flag:'wx',mode:0o600});
 console.log('Exported '+(lines.length-1)+' orders to '+id+'. Amounts are CNY cents. This is a paginated ledger export, not a settlement statement or a transaction snapshot.');
}else{
 const path=command==='list'?(id?'?before='+encodeURIComponent(id):''):command==='refund'?'/refund':'/'+id+(command==='reconcile'?'/reconcile':command==='refund-query'?'/refund-query':'');
 const body=command==='reconcile'?{reason:arg}:command==='refund'?{orderId:id,amount:Number(arg),reason,requestId}:command==='refund-query'?{refundId:arg,reason}:undefined;
 console.log(JSON.stringify(await call(path,body)));
}

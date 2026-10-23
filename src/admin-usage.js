const $=id=>document.getElementById(id),fmt=v=>Number(v||0).toLocaleString('zh-CN',{maximumFractionDigits:2}),date=v=>v?new Date(v).toLocaleString('zh-CN'):'—';
let current=null,target=null,next=null,busy=false,configDirty=false;
$('budget-form').oninput=()=>configDirty=true;
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',credentials:'same-origin'});const d=await r.json();if(!r.ok)throw Error(d.error?.message||'管理请求失败');return d;}
function message(value){$('admin-message').textContent=value;}
async function refresh(after=''){
 if(busy)return;busy=true;
 try{const result=await api('/api/admin/costs?username='+encodeURIComponent($('search').value.trim())+(after?'&after='+encodeURIComponent(after):''));
  const b=result.budget;current=b;$('admin-body').hidden=false;$('spent').textContent='¥'+fmt(b.spentCny);$('reserved').textContent='¥'+fmt(b.reservedCny);$('service-state').textContent=b.paused?'已停止':b.hardCents!==null&&(b.spentCny+b.reservedCny)*100>=b.hardCents?'预算已达上限':'可使用';
  if(!configDirty&&!$('budget-form').contains(document.activeElement)){$('warning').value=b.warningCents===null?'':b.warningCents/100;$('hard').value=b.hardCents===null?'':b.hardCents/100;$('paused').value=String(b.paused);}
  $('alerts').replaceChildren();for(const a of result.alerts){const p=document.createElement('p');p.className='service-alert';p.textContent=(a.kind==='emergency'?'紧急预算已触发':'费用预警已触发')+' · '+date(a.created_at);$('alerts').append(p);}
  $('accounts').replaceChildren();for(const account of result.accounts){if(target?.id===account.id)target=account;const row=document.createElement('tr'),u=account.usage;for(const text of [account.username,u.active||u.tier==='trial'?fmt(u.usedMinutes)+' / '+(u.minutes===null?'不限':fmt(u.minutes))+' 分钟（预留 '+fmt(u.reservedMinutes)+'）':'无可用权益',u.tier==='trial'?'免费体验不含总结':u.active?fmt(u.summariesUsed)+' / '+(u.summaries===null?'不限':fmt(u.summaries))+' 次（预留 '+fmt(u.summariesReserved)+'）':'—','¥'+fmt(account.monthlyCostCny),account.recording?'正在录音':'空闲',account.restrictedUntil>Date.now()?date(account.restrictedUntil):'未限制']){const td=document.createElement('td');td.textContent=text;row.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='选择';button.onclick=()=>{target=account;$('target').value=account.username;$('target').focus();};td.append(button);row.append(td);$('accounts').append(row);}
  next=result.next;$('more').hidden=!next;message('已更新 · '+b.month+'（UTC）；管理会话最长 30 分钟。');
 }catch(e){message(e.message+'。请使用本机管理工具重新打开受保护入口。');}finally{busy=false;}
}
async function action(fn){if(busy)return;busy=true;try{await fn();message('操作完成。');}catch(e){message(e.message);}finally{busy=false;}await refresh();}
$('budget-form').onsubmit=e=>{e.preventDefault();if(!current)return;const cents=id=>$(id).value.trim()===''?null:Math.round(Number($(id).value)*100);action(async()=>{await api('/api/admin/costs/settings',{warningCents:cents('warning'),hardCents:cents('hard'),paused:$('paused').value==='true',expectedRevision:current.revision,reason:$('budget-reason').value});configDirty=false;});};
$('search-form').onsubmit=e=>{e.preventDefault();target=null;refresh();};$('refresh').onclick=()=>refresh();$('more').onclick=()=>refresh(next);
$('account-action').onsubmit=e=>{e.preventDefault();if(!target){message('请先选择账号。');return;}action(async()=>{
 if($('action').value==='requests'){
  const data=await api('/api/admin/costs/requests',{accountId:target.id,reason:$('action-reason').value});$('requests').replaceChildren();
  for(const r of data.requests){const p=document.createElement('p');p.textContent=date(r.created_at)+' · '+r.kind+' · '+r.state+' · '+r.id;const b=document.createElement('button');b.textContent='选择补偿';b.disabled=r.state!=='completed';b.onclick=()=>{$('request-id').value=r.id;};p.append(' ',b);$('requests').append(p);}
 }else await api('/api/admin/costs/restrict',{accountId:target.id,until:Number($('action').value)?Date.now()+Number($('action').value)*60000:0,expectedUntil:target.restrictedUntil,reason:$('action-reason').value});
});};
$('compensate-form').onsubmit=e=>{e.preventDefault();action(()=>api('/api/admin/costs/compensate',{requestId:$('request-id').value.trim(),reason:$('compensate-reason').value}));};
$('logout').onclick=async()=>{try{await api('/api/admin/cost-session/logout',{});$('admin-body').hidden=true;message('已退出。');}catch(e){message(e.message);}};
const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');if(ticket)history.replaceState(null,'',location.pathname);
try{if(ticket)await api('/api/admin/cost-session/redeem',{ticket});await refresh();}catch(e){message(e.message);}
setInterval(()=>{if(!document.hidden)refresh();},30000);

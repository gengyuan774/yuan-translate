const $=id=>document.getElementById(id),fmt=n=>Math.max(0,Number(n)||0).toLocaleString('zh-CN',{maximumFractionDigits:1}),date=v=>new Date(v).toLocaleString('zh-CN');
function usageRow(label,used,reserved,limit,unit,remaining){
 const div=document.createElement('div'),p=document.createElement('p'),bar=document.createElement('progress');
 p.textContent=label+'：已用 '+fmt(used)+' '+unit+' · '+(limit===null?'不限'+(unit==='分钟'?'时长':'次数'):'剩余 '+fmt(remaining??Math.max(0,limit-used-reserved))+' '+unit+' / 共 '+fmt(limit)+' '+unit)+(reserved?'，处理中 '+fmt(reserved)+' '+unit:'');
 bar.hidden=limit===null||limit===0;bar.max=limit||1;bar.value=Math.min(limit||0,(Number(used)||0)+(Number(reserved)||0));div.append(p,bar);$('usage-values').append(div);
}
async function refresh(){
 try{const r=await fetch('/api/account/usage',{cache:'no-store'}),u=await r.json();if(!r.ok)throw Error(u.error?.message||'读取失败');
  if(!u.active&&u.tier!=='trial'){$('usage-card').hidden=true;$('usage-message').textContent='当前没有可用的翻译权益，请在个人中心查看会员或免费体验状态。';return;}
  const trial=u.tier==='trial';
  $('usage-message').textContent=u.paused?'本站已暂停新增 AI 消耗。':trial?'新账号赠送一次性 60 分钟翻译，不含课堂总结。':u.tier==='premium'?'金会员有效期内，翻译与总结不限量。':'普通会员每个 30 天用量周期含 30 小时翻译与 10 次总结。';$('usage-card').hidden=false;
  $('usage-plan').textContent=({premium:'金会员',regular:'普通会员',trial:'新账号免费体验'})[u.tier]||'我的用量';
  $('usage-period').textContent=trial?'一次性赠送，不按月重置':u.periodStart?date(u.periodStart)+' 至 '+date(u.periodEnd):'从会员生效时开始连续 30 天用量周期';
  $('usage-values').replaceChildren();
  usageRow('翻译时长',u.usedMinutes,u.reservedMinutes,u.minutes,'分钟',u.remainingMinutes);
  if(trial){const p=document.createElement('p');p.textContent='课堂总结：开通普通会员或金会员后可用。';$('usage-values').append(p);}
  else usageRow('课堂总结',u.summariesUsed,u.summariesReserved,u.summaries,'次',u.summariesRemaining);
  $('usage-restriction').textContent=u.restrictedUntil>Date.now()?'AI 服务暂时受限至 '+date(u.restrictedUntil)+'。原因：'+u.restrictionReason:'';
 }catch(e){$('usage-message').textContent=e.message;}
}
refresh();setInterval(()=>{if(!document.hidden)refresh();},30000);

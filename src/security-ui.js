import {accountId,exportLocalAccount,clearLocalAccount} from './storage.js';
const $=id=>document.getElementById(id),receiptKey='classroom-deletion-receipt';
async function call(path,body){const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});const data=await r.json();if(!r.ok){const error=new Error(data.error?.message||'操作失败，请重试');error.status=r.status;throw error;}return data;}
const fields=form=>Object.fromEntries(new FormData(form));
function saveFile(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function initAccountSecurity({locked,showMessage,setBusy}){
 let emailEnabled=false,busy=false,resetId='',bindId='',deleting=false,refreshVersion=0;
 async function refresh(user){const version=++refreshVersion;emailEnabled=false;$('account-security-panel').hidden=!user||user.provider!=='password';$('account-data-panel').hidden=!user||user.provider!=='password';
  $('recovery-open').hidden=true;$('recovery-bind').hidden=true;$('recovery-reset').hidden=true;
  $('login-method-note').textContent='当前仅支持账号密码登录。正在确认密码恢复方式…';
  $('recovery-availability').textContent='正在确认密码恢复方式…';
  try{const options=await call('/api/account/recovery/options');if(version!==refreshVersion)return;
   emailEnabled=options.email===true;$('recovery-open').hidden=!emailEnabled||!!user;$('recovery-bind').hidden=!emailEnabled||!user;
   $('login-method-note').textContent=emailEnabled?'当前仅支持账号密码登录；已绑定并验证邮箱的账号可通过邮箱找回密码。':'当前仅支持账号密码登录，暂不支持找回密码，请妥善保管账号密码。';
   if(!emailEnabled){$('recovery-availability').textContent='暂未开通密码找回，请妥善保管密码。你仍可通过下方表单修改密码。';return;}
   if(user){const info=await call('/api/account/security');if(version!==refreshVersion)return;
    $('verified-email').textContent=info.verifiedEmail?'已验证：'+info.verifiedEmail:'绑定并验证邮箱后，才可用它找回密码。';
    $('recovery-availability').textContent=info.verifiedEmail?'已绑定恢复邮箱。忘记密码时，可在登录页面通过该邮箱验证找回。':'尚未绑定恢复邮箱，忘记密码后无法通过邮箱找回。请在下方完成绑定。';
   }
  }catch{if(version!==refreshVersion)return;emailEnabled=false;$('recovery-open').hidden=true;$('recovery-bind').hidden=true;
   $('login-method-note').textContent='当前仅支持账号密码登录。密码恢复方式暂时无法确认，请稍后重试。';
   $('recovery-availability').textContent='密码恢复方式暂时无法确认，请稍后重新打开个人中心。';
  }
 }
 window.addEventListener('account-render',e=>{resetId='';bindId='';$('reset-verify-form').hidden=true;$('bind-verify-form').hidden=true;refresh(e.detail);});
 async function run(form,operation){if(busy||locked())return;busy=true;setBusy(true);const buttons=Array.from(form.querySelectorAll('button'));buttons.forEach(b=>b.disabled=true);showMessage('正在处理…');try{await operation(fields(form));form.querySelectorAll('input[type="password"]').forEach(i=>i.value='');}catch(e){showMessage(e.message);}finally{busy=false;setBusy(false);buttons.forEach(b=>b.disabled=false);}}
 $('change-password-form').onsubmit=e=>{e.preventDefault();run(e.currentTarget,async data=>{if(data.newPassword!==data.confirmation)throw new Error('两次新密码不一致');await call('/api/account/password/change',data);location.assign('/profile?login=1&passwordChanged=1&next=security');});};
 $('recovery-open').onclick=()=>{$('recovery-reset').hidden=!$('recovery-reset').hidden;};
 for(const purpose of ['reset','bind']){
  const send=$(purpose+'-send-form'),verify=$(purpose+'-verify-form');let retryAt=0;
  send.onsubmit=e=>{e.preventDefault();run(send,async data=>{if(Date.now()<retryAt)throw new Error('请稍后再发送验证码');if(!emailEnabled)throw new Error('恢复服务尚未启用');const result=await call('/api/account/recovery/'+purpose+'/send',data);if(purpose==='reset')resetId=result.challengeId;else bindId=result.challengeId;retryAt=Date.now()+result.retryAfter*1000;verify.hidden=false;showMessage(result.message);});};
  verify.onsubmit=e=>{e.preventDefault();run(verify,async data=>{if(purpose==='reset'&&data.newPassword!==data.confirmation)throw new Error('两次新密码不一致');await call('/api/account/recovery/'+purpose+'/verify',{...data,challengeId:purpose==='reset'?resetId:bindId});verify.reset();verify.hidden=true;if(purpose==='reset'){resetId='';$('recovery-reset').hidden=true;showMessage('密码已重设，所有旧登录已失效，请使用新密码登录。');}else{bindId='';const info=await call('/api/account/security');$('verified-email').textContent='已验证：'+info.verifiedEmail;$('recovery-availability').textContent='已绑定恢复邮箱。忘记密码时，可在登录页面通过该邮箱验证找回。';showMessage('恢复邮箱已验证并保存。');}});};
 }
 $('account-export-form').onsubmit=e=>{e.preventDefault();run(e.currentTarget,async data=>{
  const id=accountId(),local=await exportLocalAccount(id);const response=await fetch('/api/account/data/export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok){const err=await response.json();throw new Error(err.error?.message||'导出失败');}
  const text=await response.text();if(!text.trimEnd().endsWith('{"type":"complete"}'))throw new Error('导出未完成，请重试');if(accountId()!==id)throw new Error('账号已变化，请重试');
  saveFile(new Blob([text,JSON.stringify({type:'local_device_copy',data:local})+'\n'],{type:'application/x-ndjson;charset=utf-8'}),'满绩速翻-我的数据.jsonl');showMessage('已导出账户、课堂、资料和本机副本。文件包含你的个人数据，请妥善保存。');
 });};
 async function resume(){if(deleting)return;const saved=localStorage.getItem(receiptKey);if(!saved)return;let receipt;try{receipt=JSON.parse(saved);}catch{return;}
  deleting=true;$('deletion-progress').hidden=false;$('deletion-retry').disabled=true;
  try{let cleared=false;for(let i=0;i<30;i++){
   const result=await call('/api/account/deletion/resume',receipt);if(!cleared){await clearLocalAccount(receipt.owner);cleared=true;}
   if(result.status==='completed'){localStorage.removeItem(receiptKey);$('deletion-message').textContent='账号与云端个人数据已删除，本机副本已清理。';$('deletion-retry').hidden=true;showMessage('注销已完成。');return;}
   $('deletion-message').textContent='账号已停用，正在清理云端数据。请保留此页面；关闭后再次打开个人中心可继续处理。';await new Promise(resolve=>setTimeout(resolve,(result.retryAfter||5)*1000));
  }$('deletion-message').textContent='清理尚未完成，请点击继续。';
  }catch(e){$('deletion-message').textContent='删除尚未完成：'+e.message+'。可点击继续重试。';}finally{deleting=false;$('deletion-retry').disabled=false;}
 }
 $('account-delete-form').onsubmit=e=>{e.preventDefault();run(e.currentTarget,async data=>{
  if(data.confirmation!=='注销并删除')throw new Error('请输入“注销并删除”');
  // Verify receipt storage before disabling the account so interruption is recoverable.
  localStorage.setItem(receiptKey+'-check','1');localStorage.removeItem(receiptKey+'-check');const id=accountId();
  const receipt={jobId:crypto.randomUUID(),receipt:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),owner:id};localStorage.setItem(receiptKey,JSON.stringify(receipt));
  try{await call('/api/account/delete',{...data,deletionJobId:receipt.jobId,deletionReceipt:receipt.receipt});}catch(error){if(error.status>=400&&error.status<500)localStorage.removeItem(receiptKey);throw error;}await clearLocalAccount(id);location.assign('/profile/data?deleting=1');
 });};
 $('deletion-retry').onclick=resume;resume();
 if(new URLSearchParams(location.search).has('passwordChanged'))showMessage('密码已修改，所有旧登录已失效，请重新登录。');
}

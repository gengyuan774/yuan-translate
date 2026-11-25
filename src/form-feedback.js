import {newPasswordError,usernameError,MAX_PASSWORD} from './password-policy.js';

export function passwordFormProblem({username,password,confirmation,registering}){
 const invalidUsername=usernameError(username);if(invalidUsername)return {field:'login-username',message:invalidUsername};
 if(!password)return {field:'login-password',message:'请输入密码。'};
 const invalidPassword=registering?newPasswordError(password,username):password.length<8||password.length>MAX_PASSWORD?'密码需为 8–128 位，区分大小写。':'';
 if(invalidPassword)return {field:'login-password',message:invalidPassword};
 if(registering&&password!==confirmation)return {field:'password-confirm',message:'两次输入的密码不一致，请重新确认。'};
 return null;
}

// Keep feedback in the form that triggered it, including when a phone keyboard
// or a long registration form has scrolled the page heading out of view.
export function formFeedback(form){
 let message=form.querySelector('[data-form-feedback]');
 if(!message){message=document.createElement('p');message.dataset.formFeedback='';message.className='form-feedback';message.id=form.id+'-feedback';message.hidden=true;form.querySelector('button[type="submit"],button:not([type])')?.before(message);if(!message.isConnected)form.append(message);}
 const clear=()=>{
  message.hidden=true;message.textContent='';
  for(const input of form.querySelectorAll('[aria-invalid="true"]')){input.removeAttribute('aria-invalid');const ids=(input.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==message.id);if(ids.length)input.setAttribute('aria-describedby',ids.join(' '));else input.removeAttribute('aria-describedby');}
 };
 function show(text,{error=false,field,focus=false}={}){
  clear();if(!text)return;
  message.setAttribute('role',error?'alert':'status');message.setAttribute('aria-live',error?'assertive':'polite');message.dataset.state=error?'error':'status';message.textContent=text;message.hidden=false;
  const input=field?document.getElementById(field):null;
  if(input&&form.contains(input)){input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',[input.getAttribute('aria-describedby'),message.id].filter(Boolean).join(' '));}
  if(focus){message.scrollIntoView({block:'center',behavior:'instant'});if(input)input.focus({preventScroll:true});else{message.tabIndex=-1;message.focus({preventScroll:true});}}
 }
 return {show,clear};
}

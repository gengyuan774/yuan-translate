// New credentials share this policy in the browser and on the server. Existing
// passwords are still verified unchanged by the login path.
export const NEW_PASSWORD_MIN=8;
export const MAX_PASSWORD=128;
export const NEW_PASSWORD_HINT=`新密码至少 ${NEW_PASSWORD_MIN} 个字符，字母、数字、符号中至少包含两类。`;
export function usernameError(value){
 if(typeof value!=='string'||!value.trim())return '请输入账号。';
 return /^[a-z0-9_][a-z0-9_.-]{3,31}$/i.test(value.trim())?'':'账号需为 4–32 位英文字母、数字、下划线、点或短横线，不能以点或短横线开头。';
}
const common=new Set([
 'passwordpassword','password12345678','password123456789','password1234567890',
 'qwertyuiopasdfgh','qwertyuiop123456','123456789012345','1234567890123456',
 '123456789123456789','987654321098765','iloveyouiloveyou','welcome123456789',
 'adminadminadmin','administrator123','changemechangeme','letmeinletmein123'
]);
export function newPasswordError(value,username=''){
 if(typeof value!=='string'||Array.from(value.trim()).length<NEW_PASSWORD_MIN||value.length>MAX_PASSWORD)return `新密码需为 ${NEW_PASSWORD_MIN}–${MAX_PASSWORD} 个字符。`;
 if(!value.trim()||/[\u0000-\u001f\u007f]/.test(value))return '密码不能只有空白或包含控制字符。';
 const lower=value.toLowerCase(),simple=lower.replace(/[\s_.!@#$%^&*()+\-=]/g,'');
 if(common.has(lower)||common.has(simple))return '这个密码过于常见，请换一个不易猜到的长口令。';
 for(let size=1;size<=10&&size*2<=value.length;size++){
  if(value===value.slice(0,size).repeat(Math.ceil(value.length/size)).slice(0,value.length))return '密码不能仅由少量字符反复重复组成，请换一个长口令。';
 }
 const name=String(username).trim().toLowerCase().replace(/[\s_.!@#$%^&*()+\-=]/g,'');
 if(name&&simple.startsWith(name)&&/^[0-9]{0,4}$/.test(simple.slice(name.length)))return '请勿直接使用账号名或账号名加简单数字作为密码。';
 const characterTypes=Number(/\p{L}/u.test(value))+
  Number(/\p{Nd}/u.test(value))+
  Number(/[\p{P}\p{S}]/u.test(value));
 if(characterTypes<2)return '新密码须在字母、数字、符号中至少包含两类。';
 return '';
}

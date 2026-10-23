// New credentials share this policy in the browser and on the server. Existing
// passwords are still verified unchanged by the login path.
export const NEW_PASSWORD_MIN=15;
export const MAX_PASSWORD=128;
const common=new Set([
 'passwordpassword','password12345678','password123456789','password1234567890',
 'qwertyuiopasdfgh','qwertyuiop123456','123456789012345','1234567890123456',
 '123456789123456789','987654321098765','iloveyouiloveyou','welcome123456789',
 'adminadminadmin','administrator123','changemechangeme','letmeinletmein123'
]);
export function newPasswordError(value,username=''){
 if(typeof value!=='string'||Array.from(value.trim()).length<NEW_PASSWORD_MIN||value.length>MAX_PASSWORD)return '新密码需为 15–128 个字符，建议使用多个词组成的长口令。';
 if(!value.trim()||/[\u0000-\u001f\u007f]/.test(value))return '密码不能只有空白或包含控制字符。';
 const lower=value.toLowerCase(),simple=lower.replace(/[\s_.!@#$%^&*()+\-=]/g,'');
 if(common.has(lower)||common.has(simple))return '这个密码过于常见，请换一个不易猜到的长口令。';
 for(let size=1;size<=10;size++)if(value===value.slice(0,size).repeat(Math.ceil(value.length/size)).slice(0,value.length))return '密码不能仅由少量字符反复重复组成，请换一个长口令。';
 const name=String(username).trim().toLowerCase().replace(/[\s_.!@#$%^&*()+\-=]/g,'');
 if(name&&simple.startsWith(name)&&/^[0-9]{0,4}$/.test(simple.slice(name.length)))return '请勿直接使用账号名或账号名加简单数字作为密码。';
 return '';
}

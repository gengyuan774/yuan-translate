import {sha256} from '@noble/hashes/sha2.js';
const encoder=new TextEncoder();
export function hasLeadingZeroBits(bytes,bits){
 const whole=Math.floor(bits/8),rest=bits%8;
 for(let i=0;i<whole;i++)if(bytes[i]!==0)return false;
 return !rest||(bytes[whole]>>(8-rest))===0;
}
export function solveRegistrationProof({challengeId,nonce,difficulty},now=Date.now){
 if(typeof challengeId!=='string'||!challengeId||challengeId.length>128||typeof nonce!=='string'||!nonce||nonce.length>256||!Number.isInteger(difficulty)||difficulty<1||difficulty>24)throw new Error('安全校验参数无效，请重试。');
 const prefix=challengeId+':'+nonce+':',deadline=now()+45000;
 for(let solution=0;solution<=0xffffffff;solution++){
  if(hasLeadingZeroBits(sha256(encoder.encode(prefix+solution)),difficulty))return solution;
  if(solution%4096===0&&now()>=deadline)throw new Error('安全校验超时，请重试注册。');
 }
 throw new Error('安全校验未完成，请重试注册。');
}
if(typeof self!=='undefined')self.addEventListener('message',event=>{
 try{self.postMessage({solution:solveRegistrationProof(event.data)});}
 catch(error){self.postMessage({error:error.message||'安全校验未完成，请重试注册。'});}
});

const key='classroom-login-return';
export function rememberClassroom(owner,id,storage=sessionStorage){
 if(!owner||!id)return;
 storage.setItem(key,JSON.stringify({owner,id,expires:Date.now()+30*60*1000}));
}
export async function restoreClassroom(owner,read,storage=sessionStorage){
 const raw=storage.getItem(key);if(!raw)return null;
 let saved;try{saved=JSON.parse(raw);}catch{storage.removeItem(key);return null;}
 // Never carry another account's classroom across a login switch.
 if(saved.owner!==owner||typeof saved.id!=='string'||!Number.isFinite(saved.expires)||saved.expires<Date.now()){storage.removeItem(key);return null;}
 const classroom=await read(saved.id);storage.removeItem(key);return classroom;
}

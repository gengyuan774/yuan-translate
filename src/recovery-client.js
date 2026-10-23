export async function readCloudClass(classId,fetcher=fetch){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(classId||''))throw new Error('课堂链接不完整，请重新打开客服提供的链接。');
 async function get(path,headers={}){
  const response=await fetcher(path,{method:'GET',credentials:'same-origin',cache:'no-store',headers,signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error?.message||'云端记录暂时无法读取，请稍后重试。');error.status=response.status;throw error;}
  return data;
 }
 const {user}=await get('/api/account');
 if(!user){const error=new Error('请先登录保存这节课的账号，再返回此页面。');error.status=401;throw error;}
 const {session}=await get('/api/history/'+classId,{'X-Account-ID':user.id});
 if(session?.id!==classId||!Array.isArray(session.segments))throw new Error('课堂记录暂时无法读取，请联系客服。');
 return {user,session};
}

export class MemberError extends Error{
 constructor(message,status=503){super(message);this.status=status;}
 toJSON(){return {message:this.message};}
}
export class AccountRestriction extends MemberError{
 constructor(retryAt){
  super('账号的翻译服务暂时受限，可在个人中心的「查看用量」查询恢复时间。',403);
  this.retryAt=retryAt;
 }
 toJSON(){return {message:this.message,code:'account_restricted',retryAt:this.retryAt};}
}
export function serviceMessage(problem){
 if(problem?.code==='account_restricted'&&Number.isSafeInteger(problem.retryAt)){
  const localTime=new Date(problem.retryAt).toLocaleString('zh-CN',{hour12:false});
  return `账号的翻译服务暂时受限，可在 ${localTime} 后重试。`;
 }
 return problem?.message;
}

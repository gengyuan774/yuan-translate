// Return only our own messages and known codes, never upstream text or secrets.
export function upstreamError(status,error={}){
 const code=error?.code||error?.type;
 if(code==='insufficient_quota')return {code:'insufficient_quota',message:'OpenAI API 额度不足或已达到消费上限，请管理员检查 API 账单与额度。'};
 if(status===429)return {code:'upstream_rate_limit',message:'OpenAI 请求速率暂时受限，请稍后重试。'};
 if(status===401)return {code:'upstream_authentication',message:'OpenAI API 密钥验证失败，请管理员检查网站的密钥配置。'};
 if(status===403||code==='model_not_found')return {code:'upstream_access',message:'当前 API 项目无法使用所需模型，请管理员检查模型权限。'};
 if(status===400||status===422)return {code:'upstream_configuration',message:'实时服务请求配置不被 OpenAI 接受，请联系管理员修复。'};
 return {code:'upstream_unavailable',message:'OpenAI 服务暂时不可用，请稍后重试。'};
}

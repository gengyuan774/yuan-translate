import {adminMembership} from './admin-membership.js';
import {auditStatement} from './security-common.js';
import {MemberError} from './errors.js';

// Diagnostic metadata only. Class bodies remain accessible only to their owner.
export async function checkAdminHistory(env,username,classId){
 if(typeof classId!=='string'||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(classId))throw new MemberError('课堂编号不正确',400);
 const account=await adminMembership(env,username);
 const row=await env.DB.prepare('SELECT id,created_at,status,segment_count,revision,object_key FROM account_classes WHERE account_id=? AND id=?').bind(account.accountId,classId).first();
 if(!row)throw new MemberError('记录不存在。',404);
 if(!env.BUCKET)throw new MemberError('历史记录保存服务暂不可用',503);
 await (await auditStatement(env,account.accountId,'admin','history_checked',{classId,revision:row.revision})).run();
 const result={classId,createdAt:row.created_at,status:row.status,revision:row.revision,indexedSegments:row.segment_count};
 // Only read the path already associated with this account and class in D1.
 if(!row.object_key.startsWith(`accounts/${account.accountId}/classes/${classId}/`))throw new MemberError('课堂存储信息异常',503);
 const object=await env.BUCKET.get(row.object_key);
 if(!object)return {...result,objectStatus:'missing'};
 let session;try{session=await object.json();}catch{return {...result,objectStatus:'invalid'};}
 if(session?.id!==classId||!Array.isArray(session.segments)||!session.segments.every(s=>s&&typeof s==='object'))return {...result,objectStatus:'invalid'};
 return {...result,objectStatus:'readable',segments:session.segments.length,
  sourceSegments:session.segments.filter(s=>typeof s.source==='string'&&s.source.trim()).length,
  translatedSegments:session.segments.filter(s=>typeof s.translation==='string'&&s.translation.trim()).length,
  hasSummary:typeof session.summary==='string'&&!!session.summary.trim(),
  summaryCharacters:typeof session.summary==='string'?session.summary.length:0,
  endedAt:typeof session.endedAt==='string'?session.endedAt:null};
}

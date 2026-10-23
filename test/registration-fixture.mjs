import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handle} from '../src/worker.js';
import {req} from './server-fixture.mjs';
const noExternal=()=>{throw Error('Registration must not contact an external service');};
function hasLeadingZeroBits(bytes,bits){const full=Math.floor(bits/8),remaining=bits%8;for(let i=0;i<full;i++)if(bytes[i]!==0)return false;return !remaining||bytes[full]<(1<<(8-remaining));}

// Obtain and solve the same challenge as a browser. Only its test-database
// issuance timestamp is moved back; verification, binding and one-use checks run.
export async function mintRegistration(env,username,{headers={},now=Date.now()}={}){
 const response=await handle(req('/api/account/register/challenge',{username},'',headers),noExternal,env);
 assert.equal(response.status,200,await response.clone().text());
 const challenge=await response.json(),cookie=response.headers.get('Set-Cookie')?.split(';')[0];
 assert.ok(cookie,'Registration challenge must issue its browser cookie');
 assert.equal(challenge.difficulty,18);assert.equal(challenge.minWaitMs,750);assert.ok(challenge.expiresAt>now);
 const prefix=challenge.challengeId+':'+challenge.nonce+':';let solution=0;
 while(solution<=0xffffffff&&!hasLeadingZeroBits(createHash('sha256').update(prefix+solution).digest(),challenge.difficulty))solution++;
 assert.ok(solution<=0xffffffff,'A valid proof of work must be found');
 await env.DB.prepare('UPDATE registration_challenges SET created_at=? WHERE id=?').bind(now-1000,challenge.challengeId).run();
 return {registration:{challengeId:challenge.challengeId,solution},cookie,headers};
}

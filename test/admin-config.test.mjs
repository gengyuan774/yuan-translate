import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAdminConfig} from '../scripts/admin-config.mjs';

test('local admin tools use their configured site and refuse another production origin',()=>{
 const dir=mkdtempSync(join(tmpdir(),'admin-config-')),secretFile=join(dir,'.env.member-admin');
 try{
  writeFileSync(secretFile,'MEMBER_ADMIN_TOKEN='+'ab'.repeat(32)+'\nSERVICE_ADMIN_ORIGIN=https://new-site.example.test\n',{mode:0o600});
  assert.equal(loadAdminConfig({secretFile,overrideOrigin:''}).origin,'https://new-site.example.test');
  assert.throws(()=>loadAdminConfig({secretFile,overrideOrigin:'https://old-site.example.test'}),/another site/);
  assert.throws(()=>loadAdminConfig({secretFile,overrideOrigin:'https://new-site.example.test/path'}),/without path/);
  assert.equal(loadAdminConfig({secretFile,overrideOrigin:'http://localhost:1234'}).origin,'http://localhost:1234');
  chmodSync(secretFile,0o644);assert.throws(()=>loadAdminConfig({secretFile,overrideOrigin:''}),/mode 600/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

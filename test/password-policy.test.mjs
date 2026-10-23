import test from 'node:test';
import assert from 'node:assert/strict';
import {newPasswordError,NEW_PASSWORD_MIN,MAX_PASSWORD} from '../src/password-policy.js';
import {validPassword} from '../src/security-common.js';
test('new credentials reject weak length, whitespace, common and repeated passwords without adding composition rules',()=>{
 assert.equal(NEW_PASSWORD_MIN,15);assert.equal(MAX_PASSWORD,128);
 for(const value of ['12345678',' '.repeat(20),'a'.repeat(20),'abc123abc123abc123','password12345678','123456789012345','qwertyuiopasdfgh','\u0000a sufficient length password'])assert.ok(newPasswordError(value),JSON.stringify(value));
 for(const value of ['correct horse battery staple','A sensible classroom password 2026!','中文长口令可以使用多个不同的词语组合','🦊🐸🐙🐳🌲🍊🍋🚲🏡🎵🌼🦔🦁🏖️🍉'])assert.equal(newPasswordError(value),'',value);
 assert.ok(newPasswordError('💡'.repeat(8)), 'UTF-16 code units must not count as individual characters');
 assert.ok(newPasswordError('a'.repeat(129)));
 assert.ok(newPasswordError('a'+' '.repeat(20)));
 assert.ok(newPasswordError('12345678901234567890'));
 assert.ok(newPasswordError('complicated_name','complicated_name'));
 assert.ok(newPasswordError('complicated.name2026','complicated.name'));
 assert.ok(newPasswordError('longusername12345','longusername12345'));
 assert.ok(newPasswordError('longusername123452026','longusername12345'));
 assert.equal(newPasswordError('longusername with several other secret words','longusername'),'');
});
test('server validation applies the exact shared new-password policy and never trims or rewrites the password',()=>{
 const value='  a long and memorable phrase  ';
 assert.equal(validPassword(value),value);
 for(const value of ['short','password12345678','   '.repeat(8)])assert.throws(()=>validPassword(value),error=>error.status===400&&error.message===newPasswordError(value));
});

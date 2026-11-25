import test from 'node:test';
import assert from 'node:assert/strict';
import {newPasswordError,NEW_PASSWORD_MIN,MAX_PASSWORD} from '../src/password-policy.js';
import {validPassword} from '../src/security-common.js';
test('new passwords need eight characters and at least two character types',()=>{
 assert.equal(NEW_PASSWORD_MIN,8);assert.equal(MAX_PASSWORD,128);
 for(const value of ['Pine482k','Lake#Day','42!83#17','Q4warmwQ','中文口令山水花7','🦊🐸🐙🐳🌲🍊🍋7','A sensible classroom password 2026!'])assert.equal(newPasswordError(value),'',value);
 for(const value of ['abcdefgh','19358462','!@#%^*()','correct horse battery staple'])assert.match(newPasswordError(value),/至少包含两类/);
 assert.match(newPasswordError('Pine48k'),/8–128/);
 assert.match(newPasswordError('🦊🐸🐙🐳🌲🍊7'),/8–128/,'UTF-16 code units must not count as individual characters');
});
test('new passwords still reject common and repeated patterns, controls and account names',()=>{
 for(const value of [' '.repeat(20),'a'.repeat(20),'abc123abc123abc123','password12345678','123456789012345','qwertyuiopasdfgh','\u0000a sufficient length password 7'])assert.ok(newPasswordError(value),JSON.stringify(value));
 assert.match(newPasswordError('a1a1a1a1'),/重复/);
 assert.ok(newPasswordError('a'.repeat(129)));
 assert.ok(newPasswordError('a'+' '.repeat(20)));
 assert.ok(newPasswordError('12345678901234567890'));
 assert.ok(newPasswordError('complicated_name','complicated_name'));
 assert.ok(newPasswordError('complicated.name2026','complicated.name'));
 assert.ok(newPasswordError('longusername12345','longusername12345'));
 assert.ok(newPasswordError('longusername123452026','longusername12345'));
 assert.equal(newPasswordError('longusername with several other secret words 7','longusername'),'');
});
test('server validation applies the exact shared new-password policy and never trims or rewrites the password',()=>{
 const value='  a long and memorable phrase 7  ';
 assert.equal(validPassword(value),value);
 for(const value of ['short','password12345678','   '.repeat(8)])assert.throws(()=>validPassword(value),error=>error.status===400&&error.message===newPasswordError(value));
});

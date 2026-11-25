import {readFileSync,statSync} from 'node:fs';

// Keep credentials bound to the configured site so copied tools cannot send
// the new site's administrator token to the previous site's address.
export function loadAdminConfig({secretFile=new URL('../.env.member-admin',import.meta.url),overrideOrigin=process.env.SERVICE_ADMIN_ORIGIN}={}){
 if(statSync(secretFile).mode&0o077)throw new Error('Administrator credential file must have mode 600.');
 const content=readFileSync(secretFile,'utf8');
 const secret=content.match(/^MEMBER_ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
 const configured=content.match(/^SERVICE_ADMIN_ORIGIN=(\S+)$/m)?.[1];
 if(!secret||!configured)throw new Error('Local administrator credential and site address are required.');
 const valid=value=>{const url=new URL(value);if(url.origin!==value||url.username||url.password||(url.protocol!=='https:'&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(value)))throw new Error('Use a site origin without path or credentials.');return value;};
 valid(configured);
 const origin=valid(overrideOrigin||configured);
 if(origin!==configured&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))throw new Error('Administrator credential belongs to another site.');
 return {secret,origin};
}

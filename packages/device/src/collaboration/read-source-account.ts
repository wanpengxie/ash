import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {readLocalStateFile} from './local-state';
import {ReadSourceError} from './read-source';
const subject=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f]/.test(v);
const physical=(s:import('node:fs').BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
/** Private account continuity, not authentication or a credential export. Tokens
 * are never hashed into the durable binding. Unknown/API-key identities reject. */
export function captureReadSourceAccount(home:string,testing?:{account_id:string;subject:string}){
 if(testing){if(!subject(testing.account_id)||!subject(testing.subject))throw new ReadSourceError('invalid');const revision=createHash('sha256').update(JSON.stringify(['ash-read-account-v1','chatgpt',testing.account_id,testing.subject])).digest('hex');let released=false;return {revision,current():undefined{if(released)throw new ReadSourceError('stale');return undefined;},release(){released=true;}};}
 const path=join(home,'auth.json');let fd:number|undefined;
 try{
  const file=readLocalStateFile(path,64*1024);if(!file)throw new ReadSourceError('source_required');
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const held=fd,stat=fstatSync(held,{bigint:true});
  const safe=(s:typeof stat)=>{if(!s.isFile()||s.nlink!==1n||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o077n)!==0n)throw new ReadSourceError('offline');};safe(stat);
  if(file.identity.split(':').slice(0,6).join(':')!==physical(stat))throw new ReadSourceError('stale');
  const auth=JSON.parse(file.raw);if(auth?.auth_mode!=='chatgpt'||!subject(auth.tokens?.account_id))throw new ReadSourceError('unsupported');
  let sub:string;const token=auth.tokens.id_token;
  {
   if(typeof token!=='string'||token.length>48*1024||token.split('.').length!==3)throw new ReadSourceError('unsupported');
   const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
   if(!subject(claims.sub))throw new ReadSourceError('unsupported');sub=claims.sub;
   const account=claims['https://api.openai.com/auth']?.chatgpt_account_id;
   if(account!==undefined&&account!==auth.tokens.account_id)throw new ReadSourceError('unsupported');
  }
  const revision=createHash('sha256').update(JSON.stringify(['ash-read-account-v1','chatgpt',auth.tokens.account_id,sub])).digest('hex');
  let released=false,stale=false;
  const current=():undefined=>{try{if(released||stale)throw new ReadSourceError('stale');const now=lstatSync(path,{bigint:true}),retained=fstatSync(held,{bigint:true});safe(now);safe(retained);if(now.isSymbolicLink()||physical(now)!==physical(stat)||physical(retained)!==physical(stat))throw new ReadSourceError('stale');return undefined;}catch{stale=true;throw new ReadSourceError('stale');}};
  current();fd=undefined;return {revision,current,release(){if(!released){released=true;closeSync(held);}}};
 }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}finally{if(fd!==undefined)closeSync(fd);}
}
/** No physical timestamps, token material, executable build or config text. */
export function stableReadSourceRevision(value:{source_id?:string;endpoint_id?:string;codex_home:string;sqlite_home:string;profile:string},account:string){
 return createHash('sha256').update(JSON.stringify(['ash-read-source-stable-semantic-v1',value.source_id??null,value.endpoint_id??null,value.codex_home,value.sqlite_home,value.profile,account])).digest('hex');
}

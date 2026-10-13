// Actual installed CLI; no login or model task. All content and SQLite writes
// below are offline synthetic fixtures confined to the caller's temporary tree.
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {JsonProcess} from '../../src/agents/process.ts';
export const FIXED_VERSION='0.162.0-alpha.17.2';
export const FIXED_HASH='0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28';
export function fixedCLI(){const executable=realpathSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');if(createHash('sha256').update(readFileSync(executable)).digest('hex')!==FIXED_HASH)throw new Error('Isolated fixture requires the validated CLI artifact');return executable;}
export async function nativeReader(executable,home,osHome,cwd,realm){
 const env={HOME:osHome,CODEX_HOME:home,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'};
 const version=execFileSync(executable,['--version'],{env,encoding:'utf8',timeout:5000,maxBuffer:4096}).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];if(version!==FIXED_VERSION)throw new Error('Isolated fixture version mismatch');
 const args=realm?['-c',`sqlite_home=${JSON.stringify(realm)}`,'app-server','--stdio']:['app-server','--stdio'];
 const process=new JsonProcess({command:executable,args,env},cwd);process.onFrame=f=>{if(f.id!==undefined&&!f.method)process.settle(f.id,f.result,f.error);};
 const call=async(method,params)=>{if(!['thread/list','thread/read'].includes(method))throw new Error('Fixture only reads');return process.request(method,params,10000);};
 try{await process.request('initialize',{clientInfo:{name:'ash-isolated-real-realm',version:'1'},capabilities:{experimentalApi:true}},10000);process.write({jsonrpc:'2.0',method:'initialized',params:{}});return {process,call,close:()=>process.close()};}catch(error){await process.close();throw error;}
}
export async function createNativeRealmFixture(root){
 if(!realpathSync(root).startsWith('/private/tmp/ash-rrealm.')&&!realpathSync(root).startsWith('/tmp/ash-rrealm.'))throw new Error('Fixture requires its isolated temporary root');
 const executable=fixedCLI(),home=join(root,'home'),osHome=join(root,'os-home'),external=join(root,'external'),project=join(root,'project'),state=join(root,'state');
 for(const p of[home,osHome,external,project,state])mkdirSync(p,{mode:0o700});

 for(const realm of[home,external]){const r=await nativeReader(executable,home,osHome,project,realm===home?undefined:realm);try{await r.call('thread/list',{limit:1,cwd:[project],useStateDbOnly:true});}finally{await r.close();}}
 const markers=[];
 for(const realm of[home,external]){
  const id=randomUUID(),rollout=join(realm,'synthetic-rollout.jsonl');markers.push(id);
  const timestamp='2026-01-01T00:00:00.000Z';
  writeFileSync(rollout,JSON.stringify({timestamp,type:'session_meta',payload:{id,timestamp,cwd:project,originator:'isolated-fixture',cli_version:FIXED_VERSION,source:'cli',model_provider:'openai'}})+'\n',{mode:0o600});
  // Existing schema created by the actual CLI. This writes only our synthetic DB.
  execFileSync('python3',['-c',`import json,sqlite3,sys
v=json.load(sys.stdin); c=sqlite3.connect(v['database'])
c.execute('INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,has_user_event,cli_version,first_user_message,preview,recency_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(v['id'],v['rollout'],1767225600,1767225600,'cli','openai',v['cwd'],'synthetic fixture','{"type":"read-only"}','never',1,'0.162.0-alpha.17.2','synthetic fixture','synthetic fixture',1767225600))
c.commit(); c.close()
`],{input:JSON.stringify({database:join(realm,'state_5.sqlite'),id,rollout,cwd:project}),encoding:'utf8',timeout:5000,maxBuffer:4096});
 }
 const descriptor=(realm)=>({version:1,endpoint_id:'fixture-endpoint',source_id:'fixture-source',executable,executable_sha256:FIXED_HASH,codex_home:home,sqlite_home:realm,profile:'default',supported_versions:[FIXED_VERSION]});
 return {executable,home,osHome,external,project,state,markers,descriptor};
}

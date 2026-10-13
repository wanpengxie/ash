import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureProtectedReadSource, currentReadSource, readSourceDrained, releaseReadSource, readSourcePath } from '../../src/collaboration/read-source';
export function protectedReadFixture(endpointId='node') {
  const root=realpathSync(mkdtempSync('/tmp/ash-protected-read.'));
  const state=join(root,'state'),home=join(root,'home'),project=join(root,'project'),exe=join(root,'codex');
  for(const p of [state,home,project])mkdirSync(p,{mode:0o700});
  writeFileSync(join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'synthetic-fixture-account',id_token:[Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:'synthetic-fixture-subject',exp:4102444800,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-fixture-account'}})).toString('base64url'),'synthetic-signature'].join('.'),access_token:'synthetic-fixture-access',refresh_token:'synthetic-fixture-refresh'},last_refresh:'2026-01-01T00:00:00Z'}),{mode:0o600});
 const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
  const body=`#!${python}\n${readFileSync('packages/device/test/fixtures/read-source-cli.py','utf8')}`;
  writeFileSync(exe,body,{mode:0o700});writeFileSync(join(home,'state_5.sqlite'),'synthetic',{mode:0o600});
  const descriptor={version:1,endpoint_id:endpointId,source_id:'fixture-source',executable:exe,executable_sha256:createHash('sha256').update(body).digest('hex'),codex_home:home,sqlite_home:home,profile:'default',supported_versions:['0.0.1']};
  writeFileSync(readSourcePath(state),JSON.stringify(descriptor),{mode:0o600});
  const capture=(current?:()=>undefined)=>captureProtectedReadSource({stateDir:state,endpointId,current,testing:{home,realmVersion:'0.0.1',artifact:{sha256:descriptor.executable_sha256,version:'0.0.1'}}});
  return {root,state,home,project,descriptor,capture,port:{capture,current:currentReadSource,drained:readSourceDrained,release:releaseReadSource},cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

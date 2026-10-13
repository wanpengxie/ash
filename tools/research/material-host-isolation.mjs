import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createMock,TOOL} from './material-host-mock-responses.mjs';
export const BINARY='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export function isolatedEnv(root) {return {HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),__CFPREFERENCES_AVOID_DAEMON:'1',CODEX_HOME:path.join(root,'config'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache'),TMPDIR:path.join(root,'tmp'),PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',RUST_LOG:'error'};}
export function profile(root,codex,ports) {
  const q=JSON.stringify;
  const reads=['/usr','/System','/bin','/sbin','/dev','/private/etc','/private/var/db','/Library/Apple','/Library/Preferences','/Library/Managed Preferences','/opt/homebrew',path.dirname(path.dirname(codex))];
  return `(version 1)(deny default)\n(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)\n(allow file-read* (literal "/") ${reads.map(p=>`(subpath ${q(p)})`).join(' ')})\n(allow file-read* file-write* (subpath ${q(root)}))\n(allow file-write* (literal "/dev/null"))\n${ports.map(p=>`(allow network-inbound network-outbound (local ip "localhost:${p}") (remote ip "localhost:${p}"))`).join('\n')}\n`;
}
export async function bounded(exe,args,options={},timeout=10000) {
  const child=spawn(exe,args,{shell:false,...options});let stdout='',stderr='';child.stdout?.on('data',b=>stdout+=b);child.stderr?.on('data',b=>stderr+=b);
  return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr})});});
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label,ms=10000) {const start=Date.now();while(Date.now()-start<ms){const result=fn();if(result)return result;await delay(20);}throw Error('timeout: '+label);}
async function reservePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function connect(port,name,record){
  const ws=new WebSocket('ws://127.0.0.1:'+port);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  const pending=new Map(),events=[];let seq=0;
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);events.push(m);record({kind:'rpc_receive',connection:name,...m});if(!m.method && pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const send=m=>{record({kind:'rpc_send',connection:name,...m});ws.send(JSON.stringify(m));};
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=name+':'+(++seq);const timer=setTimeout(()=>{pending.delete(id);reject(Error('rpc timeout '+method))},10000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
  const c={ws,name,events,send,call,close(){ws.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('connection closed'));}pending.clear();}};
  await call('initialize',{clientInfo:{name:'material-isolation-'+name,version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});return c;
}
export async function run({codex,output}) {
  if(codex!==BINARY) throw Error('explicit bundled --codex path required');
  await fs.mkdir(output,{mode:0o700});const root=await fs.realpath(output);
  for(const d of ['home','config','project','cache','logs','tmp','schema'])await fs.mkdir(path.join(root,d),{mode:0o700});
  const env=isolatedEnv(root),opts={cwd:path.join(root,'project'),env};
  const events=[],report={scope:'H0 synthetic protocol only; original desktop H2 not proven',cases:[],startedAt:new Date().toISOString()};
  const record=e=>{const clean=JSON.parse(JSON.stringify(e,(k,v)=>['serverName','installationId','environmentId'].includes(k)?'<redacted-host-metadata>':v));events.push({at:Date.now(),...clean});};let child,mock,sentinel,denyServer;const connections=[];
  const cleanup=async()=>{for(const c of connections)c.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(700)]);if(child.exitCode===null)child.kill('SIGKILL');await waitFor(()=>child.exitCode!==null||child.signalCode,'child cleanup',1500);}if(mock)await mock.close();if(denyServer)await new Promise(r=>denyServer.close(r));if(sentinel)await fs.rm(sentinel);report.cleanup={childStopped:!child||child.exitCode!==null||!!child.signalCode,socketsClosed:connections.every(c=>c.ws.readyState>=2),mockClosed:!mock||!mock.server.listening};};
  const deadline=setTimeout(()=>{for(const c of connections)c.close();child?.kill('SIGTERM');mock?.server.closeAllConnections();},60000);
  try {
    report.binaryHash=createHash('sha256').update(await fs.readFile(codex)).digest('hex');
    report.nativeExecutableHash=createHash('sha256').update(await fs.readFile(path.join(path.dirname(path.dirname(codex)),'CodexCLI.app/Contents/MacOS/codex'))).digest('hex');
    report.version=(await bounded(codex,['--version'],opts)).stdout.trim();
    const help=await bounded(codex,['app-server','--help'],opts);await fs.writeFile(path.join(root,'logs','help.txt'),help.stdout);
    if(help.code!==0||!help.stdout.includes('ws://IP:PORT'))throw Error('unsupported listen flag');
    const schema=await bounded(codex,['app-server','generate-ts','--experimental','--out',path.join(root,'schema')],opts);
    if(schema.code!==0)throw Error('schema generation failed');
    const files=[];async function walk(d){for(const x of (await fs.readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(d,x.name);if(x.isDirectory())await walk(p);else files.push(p);}}await walk(path.join(root,'schema'));const h=createHash('sha256');for(const p of files)h.update(path.relative(root,p)).update(await fs.readFile(p));report.schemaHash=h.digest('hex');
    const start=await fs.readFile(path.join(root,'schema/v2/ThreadStartParams.ts'),'utf8'),resume=await fs.readFile(path.join(root,'schema/v2/ThreadResumeParams.ts'),'utf8'),settings=await fs.readFile(path.join(root,'schema/v2/ThreadSettingsUpdateParams.ts'),'utf8');
    report.schema={startDynamicTools:start.includes('dynamicTools'),resumeDynamicTools:resume.includes('dynamicTools'),settingsDynamicTools:settings.includes('dynamicTools')};
    mock=await createMock(record);const rpc=await reservePort();report.ports={mock:mock.port,rpc};
    denyServer=net.createServer(s=>s.end());await new Promise(r=>denyServer.listen(0,'127.0.0.1',r));
    sentinel=path.join(os.homedir(),'.ash-h0-sentinel-'+process.pid+'-'+Date.now());await fs.writeFile(sentinel,'synthetic sentinel',{mode:0o600,flag:'wx'});
    const sb=profile(root,codex,[mock.port,rpc]);await fs.writeFile(path.join(root,'sandbox.sb'),sb);
    const test=`const fs=require('fs'),net=require('net');fs.writeFileSync(${JSON.stringify(path.join(root,'tmp/selftest'))},'ok');if(fs.readFileSync(${JSON.stringify(path.join(root,'tmp/selftest'))},'utf8')!=='ok')throw Error('temp read');try{fs.readFileSync(${JSON.stringify(sentinel)});throw Error('SENTINEL_READ')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}function probe(host,port,allowed){return new Promise((resolve,reject)=>{const s=net.connect({host,port});const t=setTimeout(()=>{s.destroy();reject(Error('connection timeout is not denial proof'))},400);s.on('connect',()=>{clearTimeout(t);s.destroy();allowed?resolve():reject(Error('forbidden connected'))});s.on('error',e=>{clearTimeout(t);if(allowed||!['EPERM','EACCES'].includes(e.code))reject(Error('expected OS deny, got '+e.code));else{console.log('denied '+host+':'+port+' '+e.code);resolve()}})})}Promise.all([probe('127.0.0.1',${mock.port},true),probe('127.0.0.1',${denyServer.address().port},false),probe('1.1.1.1',443,false)]).then(()=>console.log('isolation_ok')).catch(e=>{console.error(e.message);process.exitCode=1})`;
    const self=await bounded('/usr/bin/sandbox-exec',['-f',path.join(root,'sandbox.sb'),process.execPath,'-e',test],opts,3000);report.selftest=self;
    if(self.code!==0||!self.stdout.includes('isolation_ok')){report.status='environment_unsupported';return report;}
    await fs.writeFile(path.join(root,'config/config.toml'),`model = "fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "isolated fixture"\nbase_url = "http://127.0.0.1:${mock.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[features]\nshell_tool = false\n`);
    const launch=async()=>{const startupOffset=events.length;child=spawn('/usr/bin/sandbox-exec',['-f',path.join(root,'sandbox.sb'),codex,'app-server','--listen','ws://127.0.0.1:'+rpc],{...opts,shell:false});report.nativePid=child.pid;record({kind:'native_start',pid:child.pid});child.stderr.on('data',b=>record({kind:'native_stderr',text:String(b).replaceAll(root,'<temp>')}));child.on('error',e=>record({kind:'native_error',text:e.message}));await waitFor(()=>events.slice(startupOffset).some(e=>e.kind==='native_stderr'&&e.text.includes('listening on:'))||child.exitCode!==null,'listener startup',2000).catch(()=>{});if(child.exitCode!==null)throw Error('native exited '+child.exitCode);};
    await launch();let a=await connect(rpc,'A1',record),b=await connect(rpc,'B1',record);connections.push(a,b);
    const common={model:'fixture',modelProvider:'fixture',cwd:opts.cwd,approvalPolicy:'never',sandbox:'read-only',environments:[]};
    const t=(await a.call('thread/start',{...common,dynamicTools:[TOOL]})).thread.id,u=(await b.call('thread/start',common)).thread.id;report.threads={T:t,U:u};await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(report.threads));
    const turn=async(name,starter,id,wrong=false)=>{mock.arm(name);const offset=events.length;await starter.call('turn/start',{threadId:id,input:[{type:'text',text:'isolated fixture '+name}],environments:[]});
      if(id===u){await waitFor(()=>events.slice(offset).some(e=>e.method==='turn/completed'),'no-tool completed');report.cases.push({name,status:'observed',dynamicToolCall:false});return;}
      await waitFor(()=>events.slice(offset).some(e=>e.method==='item/tool/call'),'tool request');await delay(60);const requests=events.slice(offset).filter(e=>e.kind==='rpc_receive'&&e.method==='item/tool/call');const req=requests[0];const owner=connections.find(c=>c.name===req.connection);const other=owner===a?b:a;
      const answer=text=>({contentItems:[{type:'inputText',text}],success:true});
      owner.send({id:'never_issued_'+name,result:answer('wrong rpc id')});await delay(80);
      if(events.slice(offset).some(e=>e.kind==='mock'&&JSON.stringify(e.toolOutput).includes('wrong rpc id')))throw Error('unissued id accepted');
      if(wrong){other.send({id:req.id,result:{...answer('wrong_connection_'+name),...(name==='wrong_metadata'?{threadId:u,turnId:'wrong_turn',callId:'wrong_call'}:{})}});await delay(150);}
      const wrongAccepted=events.slice(offset).some(e=>e.kind==='mock'&&JSON.stringify(e.toolOutput).includes('wrong_connection_'));
      if(!wrongAccepted)owner.send({id:req.id,result:answer('fixture result')});await waitFor(()=>events.slice(offset).some(e=>e.method==='turn/completed'),'turn complete');
      owner.send({id:req.id,result:answer('duplicate')});other.send({id:'wrong_rpc_id',result:answer('wrong id')});await delay(50);
      report.cases.push({name,status:'observed',starter:starter.name,receivers:requests.map(x=>x.connection),rpcId:req.id,threadId:req.params.threadId,turnId:req.params.turnId,callId:req.params.callId,wrongConnectionAccepted:wrongAccepted,modelConsumedOutputs:events.slice(offset).filter(e=>e.kind==='mock').flatMap(e=>e.toolOutput),unissuedIdAccepted:false});};
    await turn('correct_answer',a,t,false);await turn('creator',a,t,true);await turn('wrong_metadata',a,t,true);await b.call('thread/read',{threadId:t,includeTurns:true});await turn('after_read',a,t,true);await b.call('thread/resume',{threadId:t});await turn('after_resume',a,t,true);await turn('starter_B',b,t,true);
    mock.arm('pending_disconnect');const pendingOffset=events.length;await a.call('turn/start',{threadId:t,input:[{type:'text',text:'isolated pending disconnect'}],environments:[]});
    const pendingRequest=await waitFor(()=>events.slice(pendingOffset).find(e=>e.kind==='rpc_receive'&&e.connection===a.name&&e.method==='item/tool/call'),'pending disconnect request');
    a.close();await delay(100);let staleSendRejected=false;try{a.send({id:pendingRequest.id,result:{contentItems:[{type:'inputText',text:'closed connection'}],success:true}});}catch{staleSendRejected=true;}
    b.send({id:pendingRequest.id,result:{contentItems:[{type:'inputText',text:'surviving connection'}],success:true}});await waitFor(()=>events.slice(pendingOffset).some(e=>e.method==='turn/completed'),'survivor pending completion');
    report.cases.push({name:'pending_disconnect',status:'observed',staleSocketReadyState:a.ws.readyState,staleSendRejected,staleOutputConsumed:events.slice(pendingOffset).some(e=>e.kind==='mock'&&JSON.stringify(e.toolOutput).includes('closed connection')),survivingConnectionAnswered:events.slice(pendingOffset).some(e=>e.kind==='mock'&&JSON.stringify(e.toolOutput).includes('surviving connection'))});
    a=await connect(rpc,'A2',record);connections.push(a);await a.call('thread/resume',{threadId:t});await turn('reconnect',a,t,true);
    await turn('unregistered_U',b,u);report.cases.push({name:'old_thread_attach',status:'attachment_unproven',reason:'No schema dynamicTools resume/settings mutation; MCP/plugin installation alone does not prove trusted per-invocation identity or original desktop continuity.'});
    for(const c of connections)c.close();child.kill('SIGTERM');await waitFor(()=>child.exitCode!==null||child.signalCode,'restart stop',2000);await launch();a=await connect(rpc,'A3',record);b=await connect(rpc,'B2',record);connections.push(a,b);await a.call('thread/resume',{threadId:t});await turn('process_restart',a,t,true);await b.call('thread/resume',{threadId:u});await turn('U_restart',b,u);
    report.status='observations_complete';
  } catch(e){report.status='test_failure';report.error=e.message;}
  finally {clearTimeout(deadline);await cleanup();await fs.writeFile(path.join(root,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600});await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});}
  return report;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);const allowed=new Set(['--codex','--case','--output']);const values={};for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1])throw Error('invalid args');values[args[i]]=args[i+1];}if(values['--case']!=='all'||!values['--output'])throw Error('--case all --output <new-directory> required');
  const report=await run({codex:values['--codex'],output:values['--output']});console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='test_failure'?1:report.status==='environment_unsupported'?2:0;
}

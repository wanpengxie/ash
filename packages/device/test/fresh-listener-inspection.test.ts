import test from 'node:test';import assert from 'node:assert/strict';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter,once} from 'node:events';import {connect} from 'node:net';import {createInterface} from 'node:readline';import {mkdtempSync,copyFileSync,writeFileSync,readFileSync,rmSync,mkdirSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
test('fresh final kernel checks execute real version, reject shared listener ownership, and retain complete unsupported fallback',{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-fresh-listener.')),release=join(root,'release'),exe=join(root,'native'),socket=join(root,'native.sock');mkdirSync(release,{mode:0o700});
 const original=childProcess.execFileSync;let server:ReturnType<typeof childProcess.spawn>|undefined,client:ReturnType<typeof connect>|undefined,transport:any,lines:ReturnType<typeof createInterface>|undefined;const calls:string[]=[];
 try{
  original('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror','packages/device/test/fixtures/listener-evidence-server.c','-o',exe]);
  for(const name of ['listener-evidence.json','ash-listener-evidence.node'])copyFileSync(join('packages/device/dist',name),join(release,name));
  await build({entryPoints:['packages/device/src/collaboration/codex-transport.ts'],outfile:join(release,'transport.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',banner:{js:`import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(${JSON.stringify(join(process.cwd(),'package.json'))});`}});
  const api=await import(pathToFileURL(join(release,'transport.mjs')).href);server=childProcess.spawn(exe,[socket],{stdio:['pipe','pipe','ignore']});lines=createInterface({input:server.stdout!});const iterator=lines[Symbol.asyncIterator](),line=async()=>{const x=await iterator.next();assert.equal(x.done,false);return x.value;};assert.equal(await line(),'ready');client=connect(socket);await once(client,'connect');
  childProcess.execFileSync=((...args:Parameters<typeof original>)=>{calls.push(args[0]==='lsof'?'lsof':Array.isArray(args[1])&&args[1].includes('--version')?'version':'other');return original(...args);})as typeof original;syncBuiltinESMExports();
  // Native RPCs are not under test: the real isolated C process owns the actual
  // listening socket. This local initialization adapter never sends a turn.
  const ws=new EventEmitter()as any;ws.close=()=>ws.emit('close');ws.send=(raw:string)=>{const frame=JSON.parse(raw);if(frame.id!==undefined)queueMicrotask(()=>ws.emit('message',Buffer.from(JSON.stringify({id:frame.id,result:{userAgent:'fixture 0.0.1'}}))));};
  transport=new api.CodexTransport({socket,executable:exe,pid:server.pid,supportedVersions:['0.0.1'],connectSocket:async()=>ws});await transport.connect();calls.length=0;
  transport.finalCurrent();transport.finalCurrent();assert.equal(calls.filter(x=>x==='version').length,2,'each final executes --version');assert.equal(calls.filter(x=>x==='lsof').length,0,'supported kernel inspection has no redundant classic scans');
  const manifest=join(release,'listener-evidence.json'),saved=readFileSync(manifest);rmSync(manifest);calls.length=0;transport.finalCurrent();assert.equal(calls.filter(x=>x==='lsof').length,2,'unsupported keeps the full known-PID classic socket and text scans');assert.equal(calls.filter(x=>x==='version').length,1);writeFileSync(manifest,saved);
  server.stdin!.write('fork_listener\n');assert.match(await line(),/^\d+$/);calls.length=0;assert.throws(()=>transport.finalCurrent(),{code:'offline'});assert.equal(calls.filter(x=>x==='lsof').length,0,'ownership failure must never fallback');
  server.stdin!.write('drop\n');assert.equal(await line(),'done');assert.throws(()=>transport.verifyCurrent(),{code:'offline'},'replacement denial is sticky');
 }finally{
  childProcess.execFileSync=original;syncBuiltinESMExports();transport?.close();client?.destroy();if(server?.exitCode===null){server.stdin!.write('exit\n');server.stdin!.end();const timer=setTimeout(()=>server!.kill('SIGTERM'),1000);try{await once(server,'exit');}finally{clearTimeout(timer);}}lines?.close();rmSync(root,{recursive:true,force:true});
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,copyFileSync,mkdirSync,mkdtempSync,realpathSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {deviceCli} from '../src/cli';
import type {startDevice} from '../src/main';

// Exercise the real CLI setup branch and release wrapper. Pairing and the OS
// service manager are isolated; no user service or real device is touched.
async function fixture(run:(f:{base:string;release:string;root:string;config:string;project:string;lines:string[];start:typeof startDevice})=>Promise<void>,fail=false){
 const base=realpathSync(mkdtempSync(join(tmpdir(),"ash pair ' "))),release=join(base,"release ' files"),root=join(base,"state ' root"),config=join(base,"custom ' config.json"),project=join(base,"project ' folder");
 const original={home:process.env.HOME,path:process.env.PATH,argv:process.argv[1],log:console.log};const lines:string[]=[];
 try{
  for(const dir of [join(release,'bin'),root,project,join(base,'tools')])mkdirSync(dir,{recursive:true});
  // Real shipping wrapper, with a fake adjacent runtime that captures argv and
  // cwd. The suggested command must survive /bin/sh without relying on PATH.
  copyFileSync(resolve('packages/device/bin/ash-device'),join(release,'bin/ash-device'));chmodSync(join(release,'bin/ash-device'),0o755);
  writeFileSync(join(release,'node'),`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`,{mode:0o755});
  writeFileSync(join(release,'ash-device.mjs'),'// isolated runtime capture\n');
  for(const name of ['launchctl','systemctl'])writeFileSync(join(base,'tools',name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  process.env.HOME=base;process.env.PATH=join(base,'tools');process.argv[1]=join(release,'ash-device.mjs');console.log=(...args)=>lines.push(args.join(' '));
  const start=(async()=>{if(fail)throw Error('pairing rejected');return {close:async()=>{},run:Promise.resolve()};}) as unknown as typeof startDevice;
  await run({base,release,root,config,project,lines,start});
 }finally{
  console.log=original.log;process.argv[1]=original.argv;
  if(original.home===undefined)delete process.env.HOME;else process.env.HOME=original.home;
  if(original.path===undefined)delete process.env.PATH;else process.env.PATH=original.path;
  rmSync(base,{recursive:true,force:true});
 }
}
function execute(command:string,cwd:string){
 // Keep only standard OS utilities; ash-device is deliberately absent on PATH.
 return JSON.parse(execFileSync('/bin/sh',['-c',command],{cwd,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'},encoding:'utf8'}));
}
test('paired service handoff uses actual release, retains root/config, and connects from the chosen project',async()=>{
 await fixture(async f=>{
  await deviceCli(f.start,['setup','--gateway','https://fixture.invalid','--pair','fixture','--root',f.root,'--config',f.config]);
  assert(f.lines.includes('Ash device is paired and its user service is running.'));
  const instruction=f.lines.findIndex(line=>line.startsWith('First enter the project'));
  assert(instruction>0);assert(f.lines[instruction].includes('cd /path/to/project'));
  assert.deepEqual(execute(f.lines[instruction+1],f.project),{args:[`${f.release}/bin/../ash-device.mjs`,'connect','codex','--root',f.root,'--config',f.config],cwd:f.project});
  assert(!f.lines[instruction+1].includes('--project'));assert(!f.lines.some(line=>line.startsWith('Connected.')||line.includes('permission saved')));
  const saved=JSON.parse(readFileSync(f.config,'utf8'));assert.equal(saved.installRoot,f.root);assert.equal(saved.stateDir,join(f.root,'state'));
 });
});
test('no-service gives executable run command and project handoff without claiming a running service',async()=>{
 for(const mode of ['default','root','config','both'])await fixture(async f=>{
  const extra=[...(mode==='root'||mode==='both'?['--root',f.root]:[]),...(mode==='config'||mode==='both'?['--config',f.config]:[])];
  await deviceCli(f.start,['setup','--gateway','https://fixture.invalid','--pair','fixture','--no-service',...extra]);
  const config=mode==='config'||mode==='both'?f.config:join(mode==='root'?f.root:join(f.base,'.ash-device'),'device.json');
  const start=f.lines.find(line=>line.startsWith('Paired. Start with: '))!;
  assert(start);assert.deepEqual(execute(start.slice('Paired. Start with: '.length),f.project).args,[`${f.release}/bin/../ash-device.mjs`,'run','--config',config,...(mode==='root'||mode==='both'?['--root',f.root]:[])]);
  const instruction=f.lines.findIndex(line=>line.startsWith('First enter the project'));
  assert.deepEqual(execute(f.lines[instruction+1],f.project).args,[`${f.release}/bin/../ash-device.mjs`,'connect','codex',...extra]);
  assert(f.lines.includes('Keep that terminal open. In another terminal:'));assert(!f.lines.some(line=>line.includes('service is running')||line.startsWith('Connected.')));
 });
});
test('pairing failure does not print success or project authorization instructions',async()=>{
 await fixture(async f=>{
  await assert.rejects(deviceCli(f.start,['setup','--gateway','https://fixture.invalid','--pair','fixture','--no-service','--root',f.root]),/pairing rejected/);
  assert(!f.lines.some(line=>line.includes('Paired.')||line.includes('is paired')||line.includes('connect codex')||line.startsWith('Connected.')||line.includes('permission saved')));
 },true);
});

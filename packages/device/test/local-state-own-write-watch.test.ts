import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,watch,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {LocalStateTransaction} from '../src/collaboration/local-state-transaction';

test('a committed receipt survives its delayed watch notification; external changes invalidate it',async()=>{
 const root=mkdtempSync('/tmp/ash-own-write-watch-');
 const state=new LocalStateTransaction(root);
 let watcher:ReturnType<typeof watch>|undefined;
 try {
  const notified=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Own write notification was not delivered')),2000);
   watcher=watch(root,(_event,name)=>{if(String(name)==='paired.json'){clearTimeout(timer);resolve();}});
   watcher.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const receipt=state.write('paired.json','{}\n',state.capture());
  state.assertCurrent(receipt);
  await notified;
  await new Promise<void>(resolve=>setImmediate(resolve));
  state.assertCurrent(receipt);
  writeFileSync(join(root,'paired.json'),'{"external":true}\n',{mode:0o600});
  assert.throws(()=>state.assertCurrent(receipt));
 } finally {watcher?.close();state.close();rmSync(root,{recursive:true,force:true});}
});

test('restoring committed bytes through an external replacement does not preserve authorization',()=>{
 const root=mkdtempSync('/tmp/ash-own-write-replace-');
 const state=new LocalStateTransaction(root);
 try {
  const receipt=state.write('paired.json','{}\n',state.capture());
  const replacement=join(root,'replacement.json');
  writeFileSync(replacement,'{}\n',{mode:0o600});
  renameSync(replacement,join(root,'paired.json'));
  assert.throws(()=>state.assertCurrent(receipt));
 } finally {state.close();rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {LocalStateTransaction} from '../src/collaboration/local-state-transaction';

test('control runtime changes invalidate scope transactions and commits are private',()=>{
 const root=mkdtempSync('/tmp/ash-control-runtime-state-');
 const state=new LocalStateTransaction(root);
 try {
  const before=state.capture();
  const saved=state.write('collaboration-control-runtime.json','{"version":1}\n',before);
  assert.throws(()=>state.assertCurrent(before));
  state.assertCurrent(saved);
  assert.equal(statSync(join(root,'collaboration-control-runtime.json')).mode&0o777,0o600);
  writeFileSync(join(root,'collaboration-control-runtime.json'),'{"version":2}\n');
  assert.throws(()=>state.assertCurrent(saved));
 } finally {state.close();rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileSigner} from '../src/link';
import {LocalStateTransaction} from '../src/collaboration/local-state-transaction';
import {ConnectionSetupService} from '../src/setup/service';
import {MaterialSetupIpcServer, callMaterialSetup} from '../src/setup/material-ipc';

test('IPC shutdown rejects an admitted but uncommitted material apply after async verification', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipc-review-')));
  const signer = await fileSigner(root), owner = await fileSigner(join(root, 'peer'));
  const state = new LocalStateTransaction(root);
  state.write('paired.json', JSON.stringify({owner_key:owner.publicKey, permissions:[], grant_version:1}), state.capture());
  let verifyCount = 0, releaseVerification!: () => void, announceVerification!: () => void;
  const verification = new Promise<void>(resolve => {releaseVerification = resolve;});
  const entered = new Promise<void>(resolve => {announceVerification = resolve;});
  const service = new ConnectionSetupService({stateDir:root, nodeId:signer.id, endpointId:'codex',
    materialVerification:async () => {
      if (++verifyCount === 2) {announceVerification(); await verification;}
      return true;
    },
    runtime:{async reserveChange() {return {assertCurrent:() => undefined, release:() => undefined};}},
  });
  let server:MaterialSetupIpcServer | undefined;
  try {
    server = await MaterialSetupIpcServer.open(root, 'codex', service);
    const selection = {expiresAt:Date.now()+60000, grants:[{action:'receive_input', source_node_id:owner.id,
      source_endpoint_id:'materials', target:{node_id:signer.id, endpoint_id:'codex', kind:'conversation', native_id:'known'}}]};
    const preview = await callMaterialSetup(root, 'codex', 'material.prepare', {selection});
    const applying = callMaterialSetup(root, 'codex', 'material.apply',
      {preview_id:preview.preview_id, selection_hash:preview.selection_hash});
    const result = applying.then(value => ({value}), error => ({error}));
    await entered;
    assert.equal((await server.close(1)).state, 'draining');
    releaseVerification();
    await result;
    assert.equal((await server.close()).state, 'closed');
    assert.equal(state.capture().files['collaboration-material.json'], null,
      'stopping IPC must reach the final locked configuration write fence');
  } finally {
    releaseVerification();
    await server?.close();
    service.close(); state.close(); rmSync(root, {recursive:true, force:true});
  }
});

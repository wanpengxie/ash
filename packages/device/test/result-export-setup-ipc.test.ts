import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileSigner} from '../src/link';
import {ConnectionSetupService} from '../src/setup/service';
import {MaterialSetupIpcServer,callResultExportSetup} from '../src/setup/material-ipc';

test('result export management uses the protected local IPC and refuses paths or unknown approvals',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ash-result-ipc-'))), signer=await fileSigner(root);
  const service=new ConnectionSetupService({stateDir:root,nodeId:signer.id,endpointId:signer.id,runtime:{async reserveChange(){return {assertCurrent:():undefined=>undefined,release:():undefined=>undefined};}}});
  let approved=0,revoked=0;
  const server=await MaterialSetupIpcServer.open(root,signer.id,service,{pending:()=>[{pending_id:'one',path:'/fixture/result.md',byte_length:12}],async approve(id,current){current();if(id!=='one')throw Error('unknown');approved++;current();return {state:'ready'};},revoke(){revoked++;}});
  try{
    assert.equal((await callResultExportSetup(root,signer.id,'result-export.pending',{}))[0].pending_id,'one');
    await assert.rejects(callResultExportSetup(root,signer.id,'result-export.approve',{pending_id:'one',path:'/other'}));
    assert.equal(approved,0);
    await assert.rejects(callResultExportSetup(root,signer.id,'result-export.approve',{pending_id:'other'}));
    assert.equal(approved,0);
    assert.equal((await callResultExportSetup(root,signer.id,'result-export.approve',{pending_id:'one'})).state,'ready');
    assert.equal(approved,1);
    await callResultExportSetup(root,signer.id,'result-export.revoke',{});assert.equal(revoked,1);
  }finally{await server.close();service.close();rmSync(root,{recursive:true,force:true});}
  await assert.rejects(callResultExportSetup(root,signer.id,'result-export.pending',{}));
});

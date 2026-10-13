import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesktopImageComposer} from '../js/desktop-image-composer.js';
import {DesktopMaterialsStore} from '../js/desktop-materials-store.js';
import {fakePort,fakeMetadata,target} from './desktop-materials-fixture.js';
const selection={selection_id:'selected-image',name:'photo.png',media_type:'image/png',byte_length:1,sha256:'a'.repeat(64)};
function fixture({complete=true}={}){
 const port=fakePort(),metadata=fakeMetadata();port.selections=[selection];let next=0;
 const asset=(requestId,readable)=>{const ref={kind:'asset',asset_id:'image',version:1,sha256:selection.sha256,byte_length:1,media_type:'image/png',display_name:'photo.png',provenance:[],expires_at:Date.now()+90000};return {ref,readable,location:readable?'destination':'in_transit',transfer:{version:1,transfer_id:'transfer',request_id:requestId,asset_id:'image',asset_version:1,state:readable?'committed':'receiving',received_chunks:[],expires_at:Date.now()+90000,receipt:readable?{version:1,receipt_id:'receipt',transfer_id:'transfer',request_id:requestId,asset_id:'image',asset_version:1,sha256:ref.sha256,byte_length:1,destination:{kind:'work',work:target},received_at:10}:null}};};
 const submit=port.submitInput;port.submitInput=async input=>{const r=await submit(input);r.assets=[asset(input.request_id,false)];port.records.set(input.request_id,r);return r;};
 const retry=port.retryTransfer;port.retryTransfer=async input=>{const r=await retry(input);r.assets=[asset(input.request_id,complete)];port.records.set(input.request_id,r);return r;};
 const options={port,work:target,store:new DesktopMaterialsStore({metadata}),id:()=>`id-${++next}`};const c=new DesktopImageComposer(options);return {c,port,metadata,options};
}
test('one explicit image send reuses save transfer and send; pick alone never submits',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();assert.equal(c.selection.name,'photo.png');assert.equal(port.calls.some(x=>['saveDraft','submitInput','sendInput'].includes(x.method)),false);
 await c.send('看一下这张图片');assert.deepEqual(port.calls.filter(x=>['saveDraft','submitInput','retryTransfer','sendInput'].includes(x.method)).map(x=>x.method),['saveDraft','submitInput','retryTransfer','sendInput']);const send=port.calls.find(x=>x.method==='sendInput');assert.deepEqual(send.input.target,target);assert.equal(c.selection,null);
});
test('incomplete transfer never sends text or image and retry keeps original request IDs',async()=>{
 const {c,port}=fixture({complete:false});await c.initialized;await c.pick();await c.send('要求');const operation=c.op;assert.ok(operation);assert.equal(port.calls.some(x=>x.method==='sendInput'),false);await c.send('改写要求');assert.equal(c.op.operation_id,operation.operation_id);assert.equal(port.calls.filter(x=>x.method==='submitInput').length,1);assert.equal(port.calls.some(x=>x.method==='sendInput'),false);
});
test('unknown delivery reload loads original image and queries original operation without another send',async()=>{
 const {c,port,metadata,options}=fixture();await c.initialized;await c.pick();port.dropSend=true;await c.send('要求');const operation=c.op;assert.ok(operation);
 const restored=new DesktopImageComposer({...options,store:new DesktopMaterialsStore({metadata})});await restored.initialized;assert.equal(restored.selection.name,'photo.png');assert.equal(restored.op.operation_id,operation.operation_id);await restored.send('要求');assert.equal(port.calls.filter(x=>x.method==='sendInput').length,1);assert.equal(port.calls.filter(x=>x.method==='submitInput').length,1);assert.equal(restored.selection,null);
});
test('prepared operation whose request was not saved resumes the same request after query not_found',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();const submit=port.submitInput,query=port.queryInput,attempts=[];
 port.submitInput=async input=>{attempts.push(structuredClone(input));if(attempts.length===1)throw {code:'offline'};return submit(input);};
 port.queryInput=async input=>{if(!port.records.has(input.request_id)){port.calls.push({method:'queryInput',input:structuredClone(input)});throw {code:'not_found'};}return query(input);};
 await c.send('原始要求');const operation=structuredClone(c.op);assert.equal(operation.stage,'prepared');assert.equal(port.calls.filter(x=>x.method==='sendInput').length,0);
 await c.send('不得替换原始要求');assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
 const sent=port.calls.filter(x=>x.method==='sendInput');assert.equal(sent.length,1);assert.equal(sent[0].input.request_id,operation.request_id);assert.equal(sent[0].input.operation_id,operation.operation_id);assert.equal(sent[0].input.client_message_id,operation.client_message_id);
 assert.equal(port.calls.filter(x=>x.method==='saveDraft').length,1);assert.equal(port.drafts.get(operation.draft_id).text,'原始要求');assert.equal(c.selection,null);
});
test('accepted operation with query not_found refuses to submit again',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();port.submitInput=async()=>{throw {code:'offline'};};await c.send('原始要求');
 await c.store.operation({...c.op,stage:'accepted'});c.op=c.store.operations.get(c.op.draft_id);let submissions=0;port.submitInput=async()=>{submissions++;throw Error('Must not submit');};port.queryInput=async()=>{throw {code:'not_found'};};
 const reads=port.calls.filter(x=>x.method==='readRequest').length;await c.send('不可重发');assert.equal(submissions,0);assert.equal(port.calls.filter(x=>x.method==='readRequest').length,reads);assert.equal(c.op.stage,'accepted');assert.equal(port.calls.filter(x=>x.method==='sendInput').length,0);
});
test('query errors other than not_found never retry submission',async()=>{
 for(const code of ['offline','timeout','permission_denied','conflict']){
  const {c,port}=fixture();await c.initialized;await c.pick();let submissions=0;port.submitInput=async()=>{submissions++;throw {code:'offline'};};await c.send('原始要求');const operation=structuredClone(c.op);
  port.queryInput=async()=>{throw {code};};await c.send('不可自动重发');assert.equal(submissions,1);assert.deepEqual(c.op,operation);assert.equal(port.calls.filter(x=>x.method==='sendInput').length,0);
 }
});
test('multi-image and wrong MIME are rejected; switching work during picker cannot attach',async()=>{
 const {c,port}=fixture();await c.initialized;port.selections=[selection,{...selection,selection_id:'another'}];await c.pick();assert.equal(c.selection,null);port.selections=[{...selection,media_type:'image/webp'}];await c.pick();assert.equal(c.selection,null);
 let current=true,release;const held=new Promise(r=>release=r);port.selectFiles=async()=>{await held;return {cancelled:false,selections:[selection]};};c.isCurrent=()=>current;const picking=c.pick();await new Promise(r=>setImmediate(r));current=false;release();await picking;assert.equal(c.selection,null);assert.equal(port.calls.some(x=>x.method==='sendInput'),false);
});
test('operation persistence failure cannot cross submit or send boundary',async()=>{
 const {c,port,metadata}=fixture();await c.initialized;await c.pick();metadata.write=async()=>{throw Error('disk full');};await c.send('保留输入');assert.equal(port.calls.some(x=>['submitInput','sendInput'].includes(x.method)),false);assert.equal(c.selection.name,'photo.png');assert.equal(c.op,null);
});
test('failed image intent blocks plain fallback until explicit removal; real cancellation clears it',async()=>{
 const {c,port}=fixture();await c.initialized;port.selectFiles=async()=>{throw {code:'too_large'};};await c.pick();assert.equal(c.failedImage,true);assert.equal(c.handlesSend,true);await c.send('原文');assert.equal(port.calls.some(x=>['submitInput','sendInput'].includes(x.method)),false);assert.equal(c.remove(),true);assert.equal(c.handlesSend,false);
 port.selectFiles=async()=>{throw {code:'offline'};};await c.pick();assert.equal(c.handlesSend,true);port.selectFiles=async()=>({cancelled:true,selections:[]});await c.pick();assert.equal(c.failedImage,false);assert.equal(c.handlesSend,false);
});
test('send reports progress before preflight and preserves fences with short refusal notices',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();
 let release;const held=new Promise(r=>release=r);const scope=port.currentScope;port.currentScope=async()=>{await held;return scope();};
 const sending=c.send('');assert.equal(c.notice,'图片发送中…');assert.equal(c.busy,true);await c.send('');assert.match(c.notice,/处理中/);release();await sending;
 const {c:blocked,port:blockedPort}=fixture();await blocked.initialized;await blocked.pick();
 blocked.canSend=()=>false;await blocked.send('');assert.match(blocked.notice,/返回会话/);
 blocked.canSend=()=>true;blocked.isCurrent=()=>false;await blocked.send('');assert.match(blocked.notice,/授权已变化/);
 blocked.isCurrent=()=>true;blocked.initializing=true;await blocked.send('');assert.match(blocked.notice,/准备中/);
 assert.equal(blockedPort.calls.some(x=>['saveDraft','submitInput','sendInput'].includes(x.method)),false);
});
test('unsupported during send keeps the selected image and reports the sending stage',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();
 port.saveDraft=async()=>{throw {code:'unsupported'};};
 await c.send('原要求');assert.equal(c.selection.name,'photo.png');
 assert.equal(c.notice,'图片发送暂时不可用，请稍后核实');
 assert.equal(port.calls.some(x=>x.method==='sendInput'),false);
});
test('unsupported old-operation query keeps original recovery identity and never offers a picker error',async()=>{
 const {c,port,metadata,options}=fixture();await c.initialized;await c.pick();port.dropSend=true;await c.send('原要求');const operation=structuredClone(c.op);
 const restored=new DesktopImageComposer({...options,store:new DesktopMaterialsStore({metadata})});await restored.initialized;
 const recovered=structuredClone(restored.op);assert.equal(recovered.operation_id,operation.operation_id);assert.equal(recovered.request_id,operation.request_id);
 const before=port.calls.filter(x=>['submitInput','sendInput'].includes(x.method)).length;
 port.queryInput=async()=>{throw {code:'unsupported'};};await restored.send('不能替换原要求');
 assert.equal(restored.notice,'图片发送暂时不可用，请稍后核实');assert.equal(restored.selection.name,'photo.png');assert.deepEqual(restored.op,recovered);
 assert.equal(port.calls.filter(x=>['submitInput','sendInput'].includes(x.method)).length,before);
});
test('unsupported actual picker retains its original picker-stage notice',async()=>{
 const {c,port}=fixture();await c.initialized;port.selectFiles=async()=>{throw {code:'unsupported'};};await c.pick();assert.equal(c.notice,'暂时无法选择图片');assert.equal(c.selection,null);
});
test('user can dismiss unregistered old image after source close, reselect and send without resurrecting it',async()=>{
 const {c,port,metadata,options}=fixture();await c.initialized;await c.pick();const submit=port.submitInput;
 port.submitInput=async()=>{throw {code:'unsupported'};};await c.send('旧要求');const original=structuredClone(c.op);assert.equal(original.stage,'prepared');c.close();
 // Explicit fake models a source Core close with no durable asset snapshot;
 // only the old draft metadata survives. This is UI recovery, not native proof.
 port.records.clear();port.selections=[];
 const restored=new DesktopImageComposer({...options,store:new DesktopMaterialsStore({metadata})});await restored.initialized;const old=structuredClone(restored.op);assert.equal(restored.selection.name,'photo.png');
 assert.equal(await restored.remove(),true);assert.equal(restored.selection,null);assert.equal(restored.op,null);
 const persisted=[...metadata.values.values()].flatMap(v=>v.operations).find(o=>o.operation_id===original.operation_id);
 assert.equal(persisted.local_dismissed,true);assert.equal(persisted.stage,old.stage);assert.equal(persisted.request_id,original.request_id);assert.equal(port.drafts.has(original.draft_id),true,'server draft is retained');
 restored.close();const reopened=new DesktopImageComposer({...options,store:new DesktopMaterialsStore({metadata})});await reopened.initialized;assert.equal(reopened.op,null);assert.equal(reopened.selection,null);
 port.selections=[{...selection,selection_id:'replacement-image'}];port.submitInput=submit;await reopened.pick();await reopened.send('新要求');const sent=port.calls.find(x=>x.method==='sendInput');assert.ok(sent);assert.notEqual(sent.input.request_id,original.request_id);assert.notEqual(sent.input.operation_id,original.operation_id);assert.equal(reopened.selection,null);
});
test('dismissal waits for durable local metadata, retains old image on failure and refuses busy removal',async()=>{
 const {c,port,metadata}=fixture();await c.initialized;await c.pick();port.submitInput=async()=>{throw {code:'unsupported'};};await c.send('要求');const original=structuredClone(c.op);
 c.busy=true;assert.equal(c.remove(),false);c.busy=false;metadata.write=async()=>{throw Error('disk');};assert.equal(await c.remove(),false);assert.deepEqual(c.op,original);assert.equal(c.selection.name,'photo.png');assert.equal(c.notice,'暂时无法移除图片，请稍后核实');
});
test('local dismissal metadata is strictly boolean and cannot be silently undone',async()=>{
 const {c,port}=fixture();await c.initialized;await c.pick();port.submitInput=async()=>{throw {code:'unsupported'};};await c.send('要求');const original=structuredClone(c.op);
 await assert.rejects(c.store.operation({...original,local_dismissed:'yes'}));await c.store.operation({...original,local_dismissed:true});await c.store.operation({...original,local_dismissed:false});assert.equal(c.store.operations.get(original.draft_id).local_dismissed,true);
});

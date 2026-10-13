import * as C from './desktop-materials-contract.js';
import { DesktopMaterialsStore, indexedDbMaterialMetadata } from './desktop-materials-store.js';
const image = s => s && ['image/png','image/jpeg'].includes(s.media_type) && s.byte_length > 0 && s.byte_length <= C.UI_LIMITS.file_bytes;
const errors = {too_large:'请选择一张不超过 4 MiB 的 PNG 或 JPEG 图片',invalid:'请选择一张 PNG 或 JPEG 图片',permission_denied:'没有向此会话发送图片的授权',unsupported:'暂时无法选择图片',hash_mismatch:'图片校验失败，请重新选择'};
// The existing material operation owns save/transfer/send identity; this is only its composer.
export class DesktopImageComposer {
 constructor({port,work,isCurrent=()=>true,onChange=()=>{},onAccepted=()=>true,canSend=()=>true,store=new DesktopMaterialsStore({metadata:indexedDbMaterialMetadata()}),id=()=>crypto.randomUUID(),now=Date.now}) {
  C.work(work);this.port=port;this.work=C.freeze(structuredClone(work));this.isCurrent=isCurrent;this.onChange=onChange;this.onAccepted=onAccepted;this.canSend=canSend;this.store=store;this.id=id;this.now=now;this.busy=false;this.notice='';this.closed=false;this.selection=null;this.draft=null;this.op=null;this.failedImage=false;this.initializing=true;
  this.initialized=Promise.resolve().then(async()=>{try{this.controller=new AbortController();await this.ready(this.controller.signal);}catch{if(this.op)this.notice='暂时无法恢复图片，请再次点击发送核实';}finally{this.initializing=false;if(this.current())this.onChange();}});
 }
 get handlesSend(){return !!(this.selection||this.op||this.failedImage);}
 current(){return !this.closed&&this.isCurrent()&&!this.controller?.signal.aborted;}
 reject(notice){if(this.closed)return;this.notice=notice;this.onChange();}
 async run(fn,picking=false,startingNotice=''){if(this.closed)return;if(this.busy){this.reject('图片正在处理中，请稍后');return;}if(this.initializing){this.reject('图片准备中，请稍后');return;}if(!this.current()){this.reject('会话授权已变化，请重新打开');return;}this.notice=startingNotice;this.busy=true;this.controller=new AbortController();this.onChange();try{await fn(this.controller.signal);}catch(error){if(this.current()){if(picking&&!this.selection&&!this.op)this.failedImage=true;this.notice=error?.code==='unsupported'&&!picking?'图片发送暂时不可用，请稍后核实':errors[error?.code]||'暂时无法确认图片发送结果，请再次点击发送核实';}}finally{if(this.current()){this.busy=false;this.onChange();}}}
 async ready(signal){
  const scope=C.scope(await this.port.currentScope(signal));if(!this.current())return false;if(!scope.ready)C.fail(scope.reason||'unsupported');
  if(this.scope&&!C.equal(this.scope,scope))C.fail('permission_denied');this.scope=scope;await this.store.bind(scope);if(!this.current())return false;this.store.requireWritable();
  if(!this.op||!this.draft){const existing=this.op||[...this.store.operations.values()].find(o=>!o.local_dismissed&&o.draft_id.startsWith('image-')&&C.equal(o.target,this.work)&&!['accepted','rejected'].includes(o.stage));if(existing){this.op=existing;const d=await this.port.loadDraft({draft_id:existing.draft_id},signal);if(!this.current())return false;if(!d)C.fail('not_found');this.draft=C.draft(d);if(!C.equal(this.draft.target,this.work)||this.draft.scope_key!==scope.scope_key||this.draft.selections.length!==1||!image(this.draft.selections[0]))C.fail('conflict');this.selection=this.draft.selections[0];this.notice='图片发送结果待确认';}}
  return true;
 }
 async pick(){return this.run(async signal=>{if(!await this.ready(signal)||this.op)return;const p=C.picks(await this.port.selectFiles({max_files:1,max_file_bytes:C.UI_LIMITS.file_bytes,accept:['image/png','image/jpeg']},signal));if(!this.current())return;if(p.cancelled){if(!this.selection){this.failedImage=false;this.notice='';}return;}if(p.selections.length!==1||!image(p.selections[0]))C.fail('invalid');this.selection=p.selections[0];this.failedImage=false;this.draft=null;this.notice='';},true);}
 remove(){if(this.busy||this.initializing||this.closed)return false;const clear=()=>{this.selection=null;this.draft=null;this.op=null;this.failedImage=false;this.notice='';this.onChange();};if(!this.op){clear();return true;}
  const operation=this.op;this.busy=true;this.onChange();return this.store.operation({...operation,local_dismissed:true}).then(()=>{if(!this.current()||this.op!==operation)return false;clear();return true;},()=>{if(this.current())this.notice='暂时无法移除图片，请稍后核实';return false;}).finally(()=>{if(this.current()){this.busy=false;this.onChange();}});
 }
 queryBody(){const o=this.op;return {request_id:o.request_id,operation_id:o.operation_id,client_message_id:o.client_message_id,target:o.target};}
 async accept(value){if(!this.current())return;const f=C.control(value,this.op);await this.store.operation({...this.op,native_client_message_id:f.native_client_message_id,stage:f.delivery_status==='accepted'?'accepted':f.delivery_status==='rejected'?'rejected':'unknown'});if(!this.current())return;this.op=this.store.operations.get(this.op.draft_id);if(f.delivery_status==='accepted'&&f.receipt?.accepted_by==='native'){
   if(this.onAccepted(this.draft.text)!==false){this.selection=null;this.draft=null;this.op=null;this.notice='';}else this.notice='图片已发送，暂时无法清理草稿';
  }else this.notice=f.delivery_status==='rejected'?'图片未发送，请核实原发送结果':'图片发送结果待确认';
 }
 checkedRequest(value){if(!this.current())C.fail('permission_denied');const r=C.request(value);if(r.request_id!==this.op.request_id||r.kind!=='material_to_work'||!C.equal(r.target,{kind:'work',work:this.work})||!C.equal(r.source,this.scope.phone))C.fail('conflict');
  const assets=r.assets.filter(a=>a.ref.kind==='asset'),s=this.selection;if(assets.length!==1||r.assets.length!==1||assets[0].ref.display_name!==s.name||assets[0].ref.media_type!==s.media_type||assets[0].ref.byte_length!==s.byte_length||(s.sha256&&assets[0].ref.sha256!==s.sha256))C.fail('conflict');return this.store.accept(r);
 }
 async send(text){if(this.failedImage&&!this.selection&&!this.op){this.reject('请重新选择图片后发送');return;}if(!this.canSend()){this.reject('请返回会话后发送图片');return;}return this.run(async signal=>{
  if(!await this.ready(signal))return;if(!this.selection){this.reject('请先选择图片');return;}
  if(this.op){let q;try{q=await this.port.queryInput(this.queryBody(),signal);}catch(error){if(error?.code!=='not_found')throw error;if(this.op.stage==='accepted')C.fail('conflict');q=null;}
   if(!this.current())return;if(q!==null){await this.accept(q);return;}if(this.op.stage==='accepted')C.fail('conflict');
   // A missing source request is not evidence of native non-delivery. Recover
   // through the existing read/submit path with the same persisted identities;
   // the server still reconciles the operation before any native invocation.
  }
  else {
   if(typeof text!=='string'||C.byteLength(text)>C.UI_LIMITS.text_bytes)C.fail('too_large');
   const d=C.draft(await this.port.saveDraft({draft_id:this.draft?.draft_id||`image-${this.id()}`,target:this.work,text,selection_ids:[this.selection.selection_id]},signal));if(!this.current())return;
   if(d.saved!=='durable'||d.scope_key!==this.scope.scope_key||!C.equal(d.target,this.work)||d.text!==text||!C.equal(d.selections,[this.selection]))C.fail('conflict');this.draft=this.store.saveDraft(d);
   const op={draft_id:d.draft_id,request_id:this.id(),client_id:this.id(),operation_id:this.id(),client_message_id:this.id(),target:this.work,stage:'prepared'};
   await this.store.operation(op);if(!this.current())return;this.op=op;
  }
  await this.store.operation(this.op);if(!this.current())return;
  let r;try{r=this.checkedRequest(await this.port.readRequest({request_id:this.op.request_id},signal));}catch(error){if(!this.current())return;if(error?.code!=='not_found')throw error;
   r=this.checkedRequest(await this.port.submitInput({draft_id:this.op.draft_id,request_id:this.op.request_id,client_id:this.op.client_id,target:this.work},signal));if(!this.current())return;await this.store.operation({...this.op,stage:'submitted'});
  }
  if(!this.current())return;
  const complete=a=>a.readable&&['committed','acknowledged'].includes(a.transfer?.state)&&!!a.transfer.receipt&&C.equal(a.transfer.receipt.destination,{kind:'work',work:this.work});
  const a=r.assets[0];if(!complete(a)){this.notice='图片上传中…';this.onChange();r=this.checkedRequest(await this.port.retryTransfer({request_id:r.request_id,asset_id:a.ref.asset_id,asset_version:a.ref.version},signal));if(!this.current())return;
   if(!complete(r.assets[0])){this.notice='图片尚未上传完成，请再次点击发送';return;}}
  // Complete transfer is mandatory; image failure never falls back to the text path.
  if(!this.canSend()){this.notice='图片尚未发送，请返回会话后点击发送';return;}
  await this.store.operation({...this.op,stage:'sending'});if(!this.current())return;
  await this.accept(await this.port.sendInput(this.queryBody(),signal));
 },false,'图片发送中…');}
 close(){this.closed=true;this.controller?.abort();this.busy=false;this.port.close();}
}

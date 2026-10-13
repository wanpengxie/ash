import { UI_LIMITS, scope, request, draft, byteLength, freeze, equal, work, fail } from './desktop-materials-contract.js';
// Only bounded identifiers/recovery metadata are durable here. Body/bytes belong to host saveDraft/A1.
export class DesktopMaterialsStore {
 constructor({ metadata = null } = {}) { this.metadata=metadata;this.scope=null;this.requests=new Map();this.drafts=new Map();this.operations=new Map();this.answers=new Map();this.storageFault=true;this.epoch=0; }
 async bind(value) {
  const next=scope(value);if(equal(next,this.scope)&&!this.storageFault)return;
  const epoch=++this.epoch;this.scope=next;this.storageFault=true;
  this.requests.clear();this.drafts.clear();this.operations.clear();this.answers.clear();
  if(!this.metadata)return;
  try {
   const raw=await this.metadata.read(this.key());if(epoch!==this.epoch)return;
   const operations=new Map(),answers=new Map();
   if(raw!==null&&raw!==undefined){
    if(byteLength(raw)>UI_LIMITS.metadata_bytes||!raw||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).some(k=>!['version','scope_key','generation','operations','answers'].includes(k))||raw.version!==1||raw.scope_key!==next.scope_key||raw.generation!==next.generation||!Array.isArray(raw.operations)||raw.operations.length>16)fail();
    if(raw.answers!==undefined){if(!Array.isArray(raw.answers)||raw.answers.length>16)fail();for(const a of raw.answers){this.validateAnswer(a);if(answers.has(a.request_id))fail();answers.set(a.request_id,freeze(structuredClone(a)));}}
    for(const op of raw.operations){this.validateOperation(op);if(operations.has(op.draft_id))fail();operations.set(op.draft_id,freeze({...op,stage:op.stage==='accepted'?'accepted':'unknown'}));}
   }
   this.operations=operations;this.answers=answers;this.storageFault=false;
  } catch { if(epoch===this.epoch)this.storageFault=true; }
 }
 requireWritable(){if(this.storageFault||!this.metadata)fail('offline');if(!this.scope?.ready)fail('unsupported');}

 key(){return JSON.stringify([globalThis.location?.origin||'local',this.scope?.scope_key,this.scope?.generation,this.scope?.phone]);}
 clear(){this.epoch++;this.requests.clear();this.drafts.clear();this.operations.clear();this.answers.clear();this.scope=null;this.storageFault=true;}
 accept(value){const next=request(value),old=this.requests.get(next.request_id);if(old){for(const k of ['source','return_to','target','kind','role','expires_at'])if(!equal(old[k],next[k]))fail('conflict');if(next.observed_at<old.observed_at||next.fact.observed_at<old.fact.observed_at)fail('conflict');const oq=old.fact.question,nq=next.fact.question;if(oq&&(!nq||nq.question_version<oq.question_version||(nq.question_version===oq.question_version&&!equal(oq,nq))))fail('conflict');const or=old.fact.result,nr=next.fact.result;if(or&&(!nr||nr.result_version<or.result_version||(nr.result_version===or.result_version&&!equal(or,nr))))fail('conflict');if(old.fact.claimed_result_version!==null&&(next.fact.claimed_result_version===null||next.fact.claimed_result_version<old.fact.claimed_result_version))fail('conflict');for(const r of old.fact.receipts)if(!next.fact.receipts.some(n=>equal(n,r)))fail('conflict');}const map=new Map(this.requests);map.delete(next.request_id);map.set(next.request_id,next);while(map.size>UI_LIMITS.requests)map.delete(map.keys().next().value);if(byteLength([...map.values()])+byteLength([...this.drafts.values()])+byteLength([...this.operations.values()])+byteLength([...this.answers.values()])>UI_LIMITS.metadata_bytes)fail('too_large');this.requests=map;return next;}
 saveDraft(value){const d=draft(value);if(d.scope_key!==this.scope?.scope_key)fail('permission_denied');const next=new Map(this.drafts);next.set(d.draft_id,d);if(next.size>UI_LIMITS.drafts||byteLength([...next.values()])+byteLength([...this.requests.values()])+byteLength([...this.operations.values()])+byteLength([...this.answers.values()])>UI_LIMITS.metadata_bytes)fail('too_large');this.drafts=next;return d;}
 validateAnswer(a){const keys=['request_id','pending_id','question_version','reply_client_id','source','expires_at'];if(!a||Object.keys(a).length!==keys.length||Object.keys(a).some(k=>!keys.includes(k)))fail();for(const k of ['request_id','pending_id','reply_client_id'])if(typeof a[k]!=='string'||!a[k].length||byteLength(a[k])>256)fail();work(a.source);if(!Number.isSafeInteger(a.question_version)||a.question_version<1||!Number.isSafeInteger(a.expires_at)||a.expires_at<1)fail();}
 async answerIdentity(a){this.requireWritable();this.validateAnswer(a);const old=this.answers.get(a.request_id);if(old){if(equal(old,a))return old;if(a.question_version<=old.question_version||!equal(a.source,old.source))fail('conflict');}if(!this.metadata||!this.scope?.ready)fail('unsupported');const next=new Map(this.answers);next.set(a.request_id,freeze(structuredClone(a)));if(next.size>16)fail('too_large');const e=this.epoch,payload={version:1,scope_key:this.scope.scope_key,generation:this.scope.generation,operations:[...this.operations.values()],answers:[...next.values()]};if(byteLength(payload)+byteLength([...this.requests.values()])+byteLength([...this.drafts.values()])>UI_LIMITS.metadata_bytes)fail('too_large');try{await this.metadata.write(this.key(),payload);}catch{if(e===this.epoch)this.storageFault=true;fail('offline');}if(e!==this.epoch)fail('permission_denied');this.answers=next;return next.get(a.request_id);}
 validateOperation(op){const keys=['draft_id','request_id','client_id','operation_id','client_message_id','target','stage'];if(!op||keys.some(k=>!Object.hasOwn(op,k))||Object.keys(op).some(k=>!keys.includes(k)&&k!=='native_client_message_id'&&k!=='local_dismissed'))fail();if(op.local_dismissed!==undefined&&typeof op.local_dismissed!=='boolean')fail();if(op.native_client_message_id!==undefined&&op.native_client_message_id!==null&&(typeof op.native_client_message_id!=='string'||!op.native_client_message_id||byteLength(op.native_client_message_id)>256))fail();for(const k of keys.slice(0,5))if(typeof op[k]!=='string'||!op[k].length||byteLength(op[k])>256)fail();work(op.target);if(!['prepared','submitted','sending','accepted','rejected','unknown'].includes(op.stage))fail();}
 async operation(op){this.requireWritable();this.validateOperation(op);if(!this.scope?.ready)fail('unsupported');const previous=this.operations.get(op.draft_id);if(previous&&['request_id','client_id','operation_id','client_message_id','target'].some(k=>!equal(previous[k],op[k])))fail('conflict');if(previous?.native_client_message_id&&op.native_client_message_id&&previous.native_client_message_id!==op.native_client_message_id)fail('conflict');if(previous?.native_client_message_id)op={...op,native_client_message_id:previous.native_client_message_id};if(previous?.local_dismissed)op={...op,local_dismissed:true};const epoch=this.epoch,key=this.key();const next=new Map(this.operations);next.set(op.draft_id,freeze(structuredClone(op)));if(next.size>16)fail('too_large');const payload={version:1,scope_key:this.scope.scope_key,generation:this.scope.generation,operations:[...next.values()],answers:[...this.answers.values()]};if(byteLength(payload)+byteLength([...this.requests.values()])+byteLength([...this.drafts.values()])>UI_LIMITS.metadata_bytes)fail('too_large');if(!this.metadata)fail('unsupported');try{await this.metadata.write(key,payload);}catch{if(epoch===this.epoch)this.storageFault=true;fail('offline');}if(epoch!==this.epoch)fail('permission_denied');this.operations=next;return this.operations.get(op.draft_id);}
}
// Successful transactions are the persistence boundary. Existing identities are never evicted.
// The entire database is bounded at 64 scopes and 256KiB including scoped keys.
export function indexedDbMaterialMetadata(indexedDB=globalThis.indexedDB){
 if(!indexedDB)return null;
 let db;
 const open=()=>db||(db=new Promise((resolve,reject)=>{
  const r=indexedDB.open('ash.desktop-materials-metadata.v1',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('metadata');
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>{db=null;reject(r.error);};
  r.onblocked=()=>{db=null;reject(new Error('offline'));};
 }));
 const tx=async(mode,fn)=>{const database=await open();return new Promise((resolve,reject)=>{
  let value;const t=database.transaction('metadata',mode);
  t.oncomplete=()=>resolve(value);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);
  fn(t.objectStore('metadata'),v=>{value=v;});
 });};
 return {
  read:key=>tx('readonly',(s,set)=>{const r=s.get(key);r.onsuccess=()=>set(r.result);}),
  write:(key,value)=>tx('readwrite',s=>{
   const keysRequest=s.getAllKeys(null,65),valuesRequest=s.getAll(null,65);
   let keys,values;
   const persist=()=>{if(!keys||!values)return;try{
    if(keys.length!==values.length||keys.length>64)fail('too_large');
    const index=keys.indexOf(key),previous=index<0?null:values[index],merged=structuredClone(value);
    if(previous){
     if(previous.version!==1||previous.scope_key!==value.scope_key||previous.generation!==value.generation||!Array.isArray(previous.operations)||!Array.isArray(previous.answers||[]))fail('conflict');
     const operations=new Map(previous.operations.map(o=>[o.draft_id,o]));
     for(const o of value.operations){const old=operations.get(o.draft_id);if(old&&['request_id','client_id','operation_id','client_message_id','target'].some(k=>!equal(old[k],o[k])))fail('conflict');if(old?.native_client_message_id&&o.native_client_message_id&&old.native_client_message_id!==o.native_client_message_id)fail('conflict');let mergedOperation=old?.stage==='accepted'?old:old?.native_client_message_id?{...o,native_client_message_id:old.native_client_message_id}:o;if(old?.local_dismissed===true||o.local_dismissed===true)mergedOperation={...mergedOperation,local_dismissed:true};operations.set(o.draft_id,mergedOperation);}
     const answers=new Map((previous.answers||[]).map(a=>[a.request_id,a]));
     for(const a of value.answers){const old=answers.get(a.request_id);if(old&&(a.question_version<old.question_version||(a.question_version===old.question_version&&!equal(old,a))))fail('conflict');answers.set(a.request_id,a);}
     merged.operations=[...operations.values()];merged.answers=[...answers.values()];
    }
    if(merged.operations.length>16||merged.answers.length>16||(index<0&&keys.length===64))fail('too_large');
    const total=values.reduce((n,v,i)=>n+(i===index?0:byteLength(v)+byteLength(keys[i])),0)+byteLength(merged)+byteLength(key);
    if(total>UI_LIMITS.metadata_bytes)fail('too_large');
    s.put(merged,key);
   }catch{s.transaction.abort();}};
   keysRequest.onsuccess=()=>{keys=keysRequest.result;persist();};
   valuesRequest.onsuccess=()=>{values=valuesRequest.result;persist();};
  }),
  close:async()=>{if(db)(await db).close();}
 };
}

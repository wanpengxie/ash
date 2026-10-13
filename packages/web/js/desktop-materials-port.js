import * as C from './desktop-materials-contract.js';

const words = Object.freeze({currentScope:'scope',listRequests:'requests.list',readRequest:'requests.read',saveDraft:'draft.save',loadDraft:'draft.load',deleteDraft:'draft.delete',submitInput:'input.submit',sendInput:'input.send',queryInput:'input.query',answer:'answer',readAsset:'asset.read',consumeResult:'result.consume',retryTransfer:'input.retry'});
/** Materials travel over the same authenticated human connection as chat. */
export function createDesktopMaterialsPort(net,{picker=null}={}) {
 if(!net||typeof net.data!=='function')C.fail('unsupported');
 let closed=false,epoch=0;const active=new Set();
 const capture=()=>({scope:net.currentScope,binding:net.binding(),epoch});
 const current=(b,signal)=>{if(closed||signal?.aborted||b.epoch!==epoch)C.fail('offline');if(!b.scope||net.currentScope!==b.scope||!net.same(b.binding))C.fail('permission_denied');};
 async function run(fn,signal){const b=capture(),controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});active.add(controller);try{current(b,signal);const value=await fn(b,controller.signal);current(b,signal);return value;}finally{active.delete(controller);signal?.removeEventListener('abort',abort);}}
 async function call(method,input={},signal){return run(async(b,owned)=>{
  if(C.byteLength(input)>65536)C.fail('too_large');
  let answer;try{answer=await net.data('service:collaboration','collaboration.material.'+words[method],input,{signal:owned});}catch(error){C.fail(error?.detail?.code||error?.code||'offline');}
  current(b,owned);if(answer?.auth_scope!==b.scope||answer?.ok!==true)C.fail('permission_denied');
  const value=answer.result;
  if(method!=='readAsset'){if(C.byteLength(value)>65536)C.fail('too_large');return value;}
  const ref=C.ref(value.ref),stream=await net.stream(value.stream);current(b,owned);
  const bytes=stream.data;if(bytes.byteLength>C.UI_LIMITS.file_bytes||bytes.byteLength!==ref.byte_length)C.fail('too_large');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==ref.sha256)C.fail('hash_mismatch');
  return {bytes,ref,verified_sha256:hash,consume_handle:value.consume_handle};
 },signal);}
 const port=Object.fromEntries(Object.keys(words).map(method=>[method,(input,signal)=>call(method,input,signal)]));
 port.currentScope=signal=>call('currentScope',{},signal);
 port.selectFiles=(input,signal)=>run(async(b,owned)=>{if(!picker||typeof picker.selectFiles!=='function')C.fail('unsupported');if(![1,4].includes(input?.max_files)||input?.max_file_bytes!==C.UI_LIMITS.file_bytes)C.fail();const result=await picker.selectFiles(input,owned);current(b,owned);const picked=C.picks(result);if(picked.selections.length>input.max_files)C.fail('too_large');return picked;},signal);
 port.close=()=>{if(closed)return;closed=true;epoch++;for(const controller of active)controller.abort();active.clear();picker?.close?.();};
 return Object.freeze(C.assertPort(port));
}

const encode=bytes=>{let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);};
/** Bounded chunks also carry a full 4 MiB image without exceeding ash-link's frame. */
export async function importCoworkerFile(net,file,signal) {
 if(!file||file.size<1||file.size>4194304)C.fail('too_large');
 const bytes=new Uint8Array(await file.arrayBuffer());
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const binding=net.binding(),scope=net.currentScope;
 const call=async(word,body)=>{if(signal?.aborted)throw new DOMException('Aborted','AbortError');const result=await net.data('service:collaboration','collaboration.material.import'+word,body,{signal});if(signal?.aborted||!net.same(binding)||net.currentScope!==scope||result.auth_scope!==scope)C.fail('permission_denied');return result.result;};
 if(bytes.length<2.8*1024*1024)return call('',{name:file.name,media_type:file.type,data_base64:encode(bytes)});
 const import_id=crypto.randomUUID();
 await call('.begin',{import_id,name:file.name,media_type:file.type,byte_length:bytes.length,sha256:hash});
 for(let i=0;i<bytes.length;i+=40960)await call('.chunk',{import_id,chunk_index:i/40960,data_base64:encode(bytes.subarray(i,i+40960))});
 return call('.commit',{import_id});
}

export function browserMaterialPicker(net,doc=document) {
 let cancel=null;
 return {selectFiles(limits,signal){
  if(cancel)C.fail('result_unknown');
  return new Promise((resolve,reject)=>{
   const input=doc.createElement('input');input.type='file';input.multiple=limits.max_files>1;input.accept=(limits.accept||[]).join(',');input.hidden=true;doc.body.append(input);
   const finish=()=>{input.remove();signal?.removeEventListener('abort',abort);cancel=null;};
   const abort=()=>{finish();reject(new DOMException('Aborted','AbortError'));};cancel=abort;
   if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
   input.oncancel=()=>{finish();resolve({cancelled:true,selections:[]});};
   input.onchange=async()=>{try{const files=[...input.files];if(files.length>limits.max_files)C.fail('too_large');const selections=[];for(const file of files)selections.push(await importCoworkerFile(net,file,signal));finish();resolve({cancelled:files.length===0,selections});}catch(e){finish();reject(e);}};
   input.click();
  });
 },close(){cancel?.();}};
}

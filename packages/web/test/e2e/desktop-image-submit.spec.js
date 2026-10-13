import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

async function fixture(page,{complete=false}={}){
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');
  if(req.url==='/'){res.end(`<script type="module">
   import {DesktopControl} from '/js/desktop-control.js';
   import {fakePort,target} from '/test/desktop-materials-fixture.js';
   window.port=fakePort();window.work=target;
   port.selections=[{selection_id:'selected-image',name:'photo.png',media_type:'image/png',byte_length:1,sha256:'a'.repeat(64)}];
   window.net={endpoint:location.origin,currentScope:'scope',connectionId:'connectionId',collaborationControl:async()=>{throw Error('unused text control');}};
   window.grant={version:1,device_id:'device:codex',endpoint_id:'codex',grant_state:'ready',authorization_revision:'a'.repeat(64),actions:['send_input'],capabilities:['state','apply','query','reconcile']};
   window.control=new DesktopControl(document,net);control.imagePortFactory=()=>port;
   control.refresh=async()=>{};
   document.body.append(control.update([grant],{device_id:grant.device_id},work));
   const save=port.saveDraft;port.saveDraft=async input=>{const value=await save(input);await new Promise(r=>window.releaseSave=r);${complete?'return value;':"throw {code:'offline'};"}};
   const asset=requestId=>({ref:{kind:'asset',asset_id:'image',version:1,sha256:'a'.repeat(64),byte_length:1,media_type:'image/png',display_name:'photo.png',provenance:[],expires_at:Date.now()+90000},readable:true,location:'destination',transfer:{version:1,transfer_id:'transfer',request_id:requestId,asset_id:'image',asset_version:1,state:'committed',received_chunks:[],expires_at:Date.now()+90000,receipt:{version:1,receipt_id:'receipt',transfer_id:'transfer',request_id:requestId,asset_id:'image',asset_version:1,sha256:'a'.repeat(64),byte_length:1,destination:{kind:'work',work},received_at:10}}});
   const submit=port.submitInput;port.submitInput=async input=>{const r=await submit(input);r.assets=[asset(input.request_id)];port.records.set(input.request_id,r);return r;};
   window.ready=true;
  </script>`);return;}
  try{res.end(await readFile(new URL(`../../${req.url.slice(1)}`,import.meta.url)));}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready&&!control.image.initializing);
 await page.getByRole('button',{name:'选择图片'}).click();await expect(page.locator('.desktop-image-selection')).toContainText('photo.png');
 return async()=>{await page.evaluate(()=>{window.releaseSave?.();control.stop(true);});server.closeAllConnections();await new Promise(r=>server.close(r));};
}
test('same-work poll field reorder preserves image and explicit IME submit reads latest textarea',async({page})=>{
 const close=await fixture(page);try{
  await page.evaluate(()=>{window.original=control.image;control.update([grant],{device_id:grant.device_id},{native_id:work.native_id,kind:work.kind,endpoint_id:work.endpoint_id,node_id:work.node_id});});
  expect(await page.evaluate(()=>control.image===original&&control.image.current())).toBe(true);
  const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await input.focus();
  await input.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart'));el.value='最新候选';});
  await page.locator('form').evaluate(el=>el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await expect(page.locator('.desktop-image-notice')).toHaveText('图片发送中…');await expect(page.getByRole('button',{name:'发送中…',exact:true})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>port.calls.find(x=>x.method==='saveDraft')?.input.text)).toBe('最新候选');
  expect(await page.evaluate(()=>[control.composing,port.calls.some(x=>['submitInput','sendInput'].includes(x.method))])).toEqual([false,false]);
 }finally{await close();}
});
test.describe('phone touch composer',()=>{
 test.use({viewport:{width:393,height:851},isMobile:true,hasTouch:true});
 test('image-only touch submit reaches send exactly once and clears selection after receipt',async({page})=>{
  const close=await fixture(page,{complete:true});try{
   await page.getByRole('button',{name:'发送',exact:true}).tap();
   await expect(page.getByRole('button',{name:'发送中…',exact:true})).toBeDisabled();
   await page.evaluate(()=>window.releaseSave());
   await expect.poll(()=>page.evaluate(()=>port.calls.filter(x=>x.method==='sendInput').length)).toBe(1);
   await expect(page.locator('.desktop-image-selection')).not.toContainText('photo.png');
   expect(await page.evaluate(()=>port.calls.find(x=>x.method==='saveDraft').input.text)).toBe('');
  }finally{await close();}
 });
 test('offline after touch submit shows feedback and retains the selected image',async({page})=>{
  const close=await fixture(page);try{
   await page.getByRole('button',{name:'发送',exact:true}).tap();
   await expect(page.locator('.desktop-image-notice')).toHaveText('图片发送中…');
   await page.evaluate(()=>window.releaseSave());
   await expect(page.locator('.desktop-image-notice')).toContainText('暂时无法确认');
   await expect(page.locator('.desktop-image-selection')).toContainText('photo.png');
   expect(await page.evaluate(()=>port.calls.some(x=>x.method==='sendInput'))).toBe(false);
  }finally{await close();}
 });
});
test('hidden document refuses image-only submit visibly then explicit foreground submit starts',async({page})=>{
 const close=await fixture(page);try{
  await page.evaluate(async()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});await control.submit();});
  await expect(page.locator('.desktop-image-notice')).toHaveText('请返回会话后发送图片');expect(await page.evaluate(()=>port.calls.some(x=>x.method==='saveDraft'))).toBe(false);
  await page.evaluate(()=>{delete document.hidden;});await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('.desktop-image-notice')).toHaveText('图片发送中…');
  await expect.poll(()=>page.evaluate(()=>port.calls.find(x=>x.method==='saveDraft')?.input.text)).toBe('');
 }finally{await close();}
});

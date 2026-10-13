import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {chromium} from '@playwright/test';
test('actual IndexedDB merge retains local dismissal across stale writers including accepted metadata',{timeout:20000},async()=>{
 const bundled=await build({entryPoints:[fileURLToPath(new URL('../js/desktop-materials-store.js',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'MaterialMetadata',platform:'browser'});
 const server=createServer((_req,res)=>res.end('<!doctype html><body></body>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:process.platform==='darwin'?{channel:'chrome'}:{})});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundled.outputFiles[0].text});
  const rows=await page.evaluate(async()=>{
   const metadata=MaterialMetadata.indexedDbMaterialMetadata(),base={draft_id:'image-draft',request_id:'request',client_id:'client',operation_id:'operation',client_message_id:'message',target:{kind:'conversation',node_id:'mac',endpoint_id:'codex',native_id:'thread'},stage:'unknown'};
   const value=op=>({version:1,scope_key:'test-scope',generation:'test-generation',operations:[op],answers:[]});
   await metadata.write('unknown',value({...base,local_dismissed:true}));await metadata.write('unknown',value(base));
   const accepted={...base,stage:'accepted',native_client_message_id:'native-journal-marker'};await metadata.write('accepted',value(accepted));await metadata.write('accepted',value({...base,local_dismissed:true}));
   return {unknown:(await metadata.read('unknown')).operations[0],accepted:(await metadata.read('accepted')).operations[0]};
  });assert.equal(rows.unknown.local_dismissed,true);assert.equal(rows.unknown.stage,'unknown');assert.equal(rows.accepted.local_dismissed,true);assert.equal(rows.accepted.stage,'accepted');assert.equal(rows.accepted.native_client_message_id,'native-journal-marker');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

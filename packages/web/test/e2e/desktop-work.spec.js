import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('desktop refresh preserves the composer, focus and IME draft while new replies arrive', async ({page}) => {
 const source = await readFile(new URL('../../index.html', import.meta.url),'utf8');
 const bundle = await build({stdin:{contents:'import {DesktopWork} from "./desktop-work.js"; window.DesktopWork=DesktopWork;',resolveDir:fileURLToPath(new URL('../../js',import.meta.url))},bundle:true,write:false,format:'esm'});
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:`${source.match(/<style>[\s\S]*?<\/style>/)[0]}<section id="desktopWork"></section><script type="module" src="/fixture.js"></script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.DesktopWork);
  await page.evaluate(()=>{
   const target={device_id:'device:one',node_id:'one',endpoint_id:'one',name:'电脑',version:1,adapter:'desktop/codex',authorization_generation:1,authorization_revision:'a'.repeat(64),authorization_state:'ready',source:'codex.saved_history',runtime_state:'unknown',runtime_availability:'unknown',scope_kind:'exact_cwd',control:'unsupported',actions:['list_work','read_work']};
   const control={version:1,device_id:'device:one',endpoint_id:'one',name:'电脑',grant_state:'ready',authorization_revision:'b'.repeat(64),actions:['send_input','steer'],capabilities:['state','apply','query','reconcile']};
   window.work={node_id:'one',endpoint_id:'one',kind:'conversation',native_id:'thread'};
   window.net={endpoint:location.origin,currentScope:'scope',connectionId:'connection',collaborationEndpoints:async()=>({auth_scope:'scope',targets:[target]}),collaborationControlEndpoints:async()=>({auth_scope:'scope',control_targets:[control]}),collaborationRead:async()=>({auth_scope:'scope',target:{device_id:target.device_id,node_id:'one',endpoint_id:'one',authorization_generation:1,authorization_revision:target.authorization_revision},page:{items:[{turn_id:'turn',history_status:null,status_source:'codex.saved_history',messages:[{work,turn_id:'turn',source_message_id:'message',role:'assistant',text:'回复',material_refs:[]}]}],next_cursor:null,observed_at:'2026-10-13T00:00:00Z',source:'codex.saved_history',runtime_state:'unknown',completeness:'source_page'}}),collaborationControl:async()=>{throw {code:'offline'};}};
   window.desktop=new DesktopWork(document.querySelector('#desktopWork'),net,{pollMs:60000});desktop.opened=true;desktop.target=target;desktop.work=work;desktop.targets=[target];desktop.root.hidden=false;desktop.refresh();
  });
  const input=page.getByRole('textbox');await expect(input).toBeVisible();await input.fill('还在输入的草稿');await input.focus();
  await page.evaluate(()=>{window.originalInput=document.querySelector('textarea');originalInput.dispatchEvent(new CompositionEvent('compositionstart'));});
  await page.evaluate(()=>desktop.refresh());
  await expect(input).toHaveValue('还在输入的草稿');expect(await page.evaluate(()=>document.querySelector('textarea')===originalInput&&document.activeElement===originalInput)).toBe(true);
 } finally {await new Promise(r=>server.close(r));}
});

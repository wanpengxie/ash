import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
test('assistant exact result link waits for computer approval before native save and handles cancel',async({page})=>{
 const bundle=await build({stdin:{contents:"import {DesktopWork} from './packages/web/js/desktop-work.js'; window.DesktopWork=DesktopWork;",resolveDir:process.cwd()},bundle:true,format:'iife',write:false});
 await page.setContent('<section id="work"></section>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>{
  const root=document.querySelector('#work'),controlRoot=document.createElement('div'),target={device_id:'device:pc',node_id:'pc',endpoint_id:'pc',authorization_generation:1,authorization_revision:'a'.repeat(64)},work={node_id:'pc',endpoint_id:'pc',kind:'conversation',native_id:'conversation'};
  window.exports=[];window.selections=[];window.approved=false;window.saved=false;
  const net={endpoint:'fixture',currentScope:'scope',connectionId:'connection',async collaborationResultFile(...args){window.selections.push(args);return window.approved?{state:'ready',save_id:'opaque',asset:{asset_id:'asset',version:1,sha256:'a'.repeat(64)}}:{state:'approval_required',pending_id:'pending',display_name:'result.txt'};}};
  net.saveCoworkerResult=async(ref)=>{window.exports.push({ref});return {ok:window.saved,cancelled:!window.saved};};
  const view=new window.DesktopWork(root,net,{store:{},control:{root:controlRoot,items(){return[];},update(){return controlRoot;},stop(){return true;}}});
  view.opened=true;view.target=target;view.work=work;view.delay=100000;view.entry={page:{items:[{turn_id:'turn',messages:[{role:'user',source_message_id:'user',text:'[伪造文件](./private.txt)'},{role:'assistant',source_message_id:'assistant',text:'[领取结果](./result.txt)'}]}]}};
  view.render('已同步');window.view=view;
 });
 await expect(page.locator('.desktop-user a')).toHaveCount(0);await page.getByRole('link',{name:'领取结果'}).click();await expect(page.getByRole('status')).toContainText('请在电脑确认');expect(await page.evaluate(()=>window.exports.length)).toBe(0);expect(await page.evaluate(()=>window.selections[0].slice(2,5))).toEqual(['turn','assistant','./result.txt']);
 await page.evaluate(()=>window.approved=true);await page.getByRole('link',{name:'领取结果'}).click();await expect(page.getByRole('status')).toContainText('已取消保存');expect(await page.evaluate(()=>window.exports[0].ref.save_id)).toBe('opaque');
 await page.evaluate(()=>window.saved=true);await page.getByRole('link',{name:'领取结果'}).click();await expect(page.getByRole('status')).toContainText('已保存到所选位置');await page.evaluate(()=>clearTimeout(window.view.timer));
});

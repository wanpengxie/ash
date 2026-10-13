import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
const ui=fileURLToPath(new URL('../../',import.meta.url));
const target={version:1,device_id:'device:one',endpoint_id:'one',name:'电脑',grant_state:'ready',authorization_revision:'a'.repeat(64),scope:{kind:'exact_cwd',cwd:'/project'},actions:['projects','apply','query','reconcile'],capabilities:['projects','apply','query','reconcile']};
function fact(r,mode){const work={node_id:'one',endpoint_id:'one',kind:'conversation',native_id:'real-thread'};const phase=stage=>{const idle=mode==='name-fail'&&stage==='first_input';const status=idle?'not_started':mode==='unknown'&&stage==='first_input'?'unknown':mode==='name-fail'&&stage==='name'?'rejected':'accepted';return {status,attempt_id:idle?null:`attempt-${stage}`,connector_epoch:idle?null:'epoch',native_interface_version:idle?null:'1.2.3',started_at:idle?null:1,observed_at:2,receipt:status==='accepted'?{stage,accepted_by:'native',work,...(stage==='first_input'?{native_turn_id:'turn',native_message_id:'message',correlation:'stable_message_id'}:{})}:null,error_code:status==='rejected'?'offline':status==='unknown'?'result_unknown':null};};return {version:1,request_id:r.request_id,operation_id:r.operation_id,authorization_revision:r.authorization_revision,target:r.target,expires_at:r.expires_at,status:'recorded',create:phase('create'),name:phase('name'),first_input:phase('first_input'),work,native_client_message_id:mode==='name-fail'?null:'client',reconciliation:null,error_code:null,observed_at:2};}
async function fixture(page,mode='success'){
  const bundle=await build({stdin:{contents:'import {DesktopWork} from "./desktop-work.js";import {DesktopCreate} from "./desktop-create.js";Object.assign(window,{DesktopWork,DesktopCreate});',resolveDir:join(ui,'js')},bundle:true,write:false,format:'esm'});
  const requests=[],facts=new Map();let targets=[target],hold=false,release,projectsOffline=false,projects=[{project_id:'real-project',cwd:'/project'}];const gate=new Promise(r=>{release=r;});
  const server=createServer(async(req,res)=>{try{res.setHeader('Cache-Control','no-store');if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}if(req.url.startsWith('/api/')){let body='';for await(const c of req)body+=c;const input=body?JSON.parse(body):null;requests.push({url:req.url,input});let data={ok:true,auth_scope:'scope'};
    if(req.url==='/api/collaboration/create/endpoints')data.create_targets=targets;
    else if(req.url==='/api/collaboration/endpoints')data.targets=[];
    else if(req.url.endsWith('/projects') && projectsOffline){res.statusCode=503;res.end(JSON.stringify({ok:false,error:{code:'offline'}}));return;}else if(req.url.endsWith('/projects'))Object.assign(data,{target:{node_id:'one',endpoint_id:'one',cwd:'/project'},authorization_revision:target.authorization_revision,connector_epoch:'epoch',native_interface_version:'1.2.3',projects,complete:true});
    else if(req.url.endsWith('/apply')){const f=fact(input.request,mode);facts.set(input.request.operation_id,f);data.fact=f;if(hold)await gate;}
    else data.fact=facts.get(input.operation_id)||null;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;}
    res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');if(req.url==='/')res.end('<main id="read"></main><script type="module" src="/fixture.js"></script>');else res.end(await readFile(join(ui,req.url.slice(1))));
  }catch{res.statusCode=500;res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  async function mount(){await page.goto(url);await page.waitForFunction(()=>window.DesktopWork);await page.evaluate(()=>{window.net={endpoint:location.origin,currentScope:'scope',connectionId:'screen',async collaborationCreateEndpoints(signal){return (await fetch('/api/collaboration/create/endpoints',{signal})).json();},async collaborationEndpoints(signal){return(await fetch('/api/collaboration/endpoints',{signal})).json();},async collaborationCreate(op,input,signal){return (await fetch(`/api/collaboration/create/${op}`,{method:'POST',body:JSON.stringify(input),signal})).json();}};window.view=new DesktopWork(document.querySelector('#read'),net);view.open();});}
  await mount();return {requests,mount,set projects(p){projects=p;},set projectsOffline(v){projectsOffline=v;},acceptSaved(){for(const [op,f]of facts)facts.set(op,fact(f,'success'));},set targets(t){targets=t;},hold(){hold=true;},release,async close(){release();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
async function prepare(page){await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByLabel('内容',{exact:true}).fill('private first input');}
test('create-only grant chooses actual project and explicit three-stage submission; created ref does not fabricate history',async({page})=>{const f=await fixture(page);try{await expect(page.locator('#read')).toContainText('暂时没有可读取的电脑');await prepare(page);expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(0);await page.getByRole('button',{name:'创建',exact:true}).click();await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');await expect(page.locator('.desktop-create-operation details p').first()).not.toBeVisible();expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);expect(f.requests.find(r=>r.url.endsWith('/apply')).input.request.target.project_id).toBe('real-project');await page.getByRole('button',{name:'打开会话'}).click();await expect(page.locator('.desktop-create')).toContainText('当前没有历史读取授权');await expect(page.locator('.desktop-messages')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('ash.desktop.create-outbox.v1'))).not.toContain('private first input');}finally{await f.close();}});
test('partial name failure retains same real thread and does not start first input',async({page})=>{const f=await fixture(page,'name-fail');try{await prepare(page);await page.getByRole('button',{name:'创建'}).click();await expect(page.locator('.desktop-create-operation')).toContainText('标题：失败');await expect(page.locator('.desktop-create-operation')).toContainText('消息：尚未开始');await expect(page.locator('.desktop-create-operation')).toContainText('real-thread');expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);}finally{await f.close();}});
test('unknown survives reload; query and reconcile never replay apply or allocate new operation',async({page})=>{const f=await fixture(page,'unknown');try{await prepare(page);await page.getByRole('button',{name:'创建'}).click();await expect(page.locator('.desktop-create-operation')).toContainText('消息：待确认');await expect.poll(()=>f.requests.filter(r=>r.url.endsWith('/apply')).length).toBe(1);await expect(page.locator('.desktop-create-operation')).toContainText('创建：已确认');const op=f.requests.find(r=>r.url.endsWith('/apply')).input.request.operation_id;await f.mount();await page.getByRole('button',{name:'新建会话'}).click();await expect(page.locator('.desktop-create-operation')).toContainText('消息：待确认');await page.locator('.desktop-create-operation summary').click();await page.getByRole('button',{name:'核查结果'}).click();await expect.poll(()=>f.requests.filter(r=>r.url.endsWith('/reconcile')).length).toBe(1);expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);expect(f.requests.filter(r=>/query|reconcile/.test(r.url)).every(r=>r.input.operation_id===op)).toBe(true);await expect(page.getByRole('button',{name:/重试|重发/})).toHaveCount(0);}finally{await f.close();}});
test('late native response after grant revoke cannot expose receipt and close cancels only HTTP',async({page})=>{const f=await fixture(page);try{await prepare(page);f.hold();await page.getByRole('button',{name:'创建'}).click();await expect.poll(()=>f.requests.filter(r=>r.url.endsWith('/apply')).length).toBe(1);f.targets=[];f.release();await expect(page.locator('.desktop-create')).toContainText('创建范围已改变或撤销');await expect(page.locator('.desktop-create-operation')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('ash.desktop.create-outbox.v1'))).not.toContain('real-thread');await page.getByRole('button',{name:'关闭新建'}).click();await expect(page.locator('.desktop-create')).toBeHidden();expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);}finally{await f.close();}});
test('saved receipt refresh works when native project enumeration is offline',async({page})=>{const f=await fixture(page,'unknown');try{await prepare(page);await page.getByRole('button',{name:'创建'}).click();await expect(page.locator('.desktop-create-operation')).toContainText('创建：已确认');f.acceptSaved();f.projectsOffline=true;await f.mount();await page.getByRole('button',{name:'新建会话'}).click();await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');await expect(page.locator('.desktop-create')).toContainText('暂时无法确认');await expect(page.getByRole('button',{name:'创建'})).toBeDisabled();expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);}finally{await f.close();}});
test('multiple ready computers and projects keep explicit selection and never apply on discovery',async({page})=>{
  const f=await fixture(page);try{
    f.targets=[target,{...target,endpoint_id:'two',device_id:'device:two',name:'另一台'}];f.projects=[{project_id:'real-project',cwd:'/project'},{project_id:'second-project',cwd:'/project'}];
    await page.getByRole('button',{name:'新建会话',exact:true}).click();await expect(page.getByRole('button',{name:'电脑 · 新建会话',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'内容'})).toHaveCount(0);
    await page.getByRole('button',{name:'电脑 · 新建会话',exact:true}).click();await expect(page.getByLabel('项目')).toBeEnabled();await expect(page.getByLabel('项目')).toBeVisible();await expect(page.getByLabel('项目')).toHaveValue('');
    await expect(page.getByLabel('内容')).toBeDisabled();await page.getByLabel('项目').selectOption('second-project');await expect(page.getByLabel('内容')).toBeEnabled();expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);
  }finally{await f.close();}
});
test('unique defaults show destination and refresh preserves focused composition; tap creates from committed candidate',async({page})=>{
  const f=await fixture(page);try{
    await prepare(page);await expect(page.getByLabel('标题',{exact:true})).toHaveCount(0);await expect(page.getByText('电脑 · project',{exact:true})).toBeVisible();
    const input=page.getByLabel('内容');await input.focus();
    await page.evaluate(async()=>{const c=view.create;window.initialCreateInput=c.draftInput;window.createBlurs=0;initialCreateInput.addEventListener('blur',()=>createBlurs++);initialCreateInput.dispatchEvent(new CompositionEvent('compositionstart'));initialCreateInput.value='中文要求。下一句';initialCreateInput.setSelectionRange(2,4);await c.refresh();});
    expect(await page.evaluate(()=>[view.create.draftInput===initialCreateInput,document.activeElement===initialCreateInput,initialCreateInput.value,initialCreateInput.selectionStart,initialCreateInput.selectionEnd,createBlurs])).toEqual([true,true,'中文要求。下一句',2,4,0]);
    await expect(page.getByRole('button',{name:'创建',exact:true})).toBeEnabled();await page.evaluate(()=>void view.create.submit());expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);
    await page.getByRole('button',{name:'创建',exact:true}).click();await expect(page.locator('.desktop-create-operation')).toContainText('已创建');
    const request=f.requests.find(r=>r.url.endsWith('/apply')).input.request;expect(request.title).toBe('中文要求。');expect(request.input.text).toBe('中文要求。下一句');
    await page.evaluate(()=>{view.create.stop();initialCreateInput.value='旧范围内容';initialCreateInput.dispatchEvent(new Event('blur'));initialCreateInput.dispatchEvent(new InputEvent('input'));});expect(await page.evaluate(()=>view.create.input)).toBe('');
  }finally{await f.close();}
});
test('share chooser opens new conversation with editable text and only explicit create applies',async({page})=>{
 const f=await fixture(page);try{
  expect(await page.evaluate(()=>view.receiveShare({id:'new-share',text:'看看这篇文章\nhttps://example.com/article'}))).toBe(true);
  await page.getByRole('button',{name:'新建会话',exact:true}).click();const input=page.getByLabel('内容',{exact:true});
  await expect(input).toHaveValue('看看这篇文章\nhttps://example.com/article');await input.fill('看看这篇文章\nhttps://example.com/article\n请提炼重点');
  await page.evaluate(()=>view.create.refresh());await expect(input).toHaveValue('看看这篇文章\nhttps://example.com/article\n请提炼重点');expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);
  await page.getByRole('button',{name:'创建',exact:true}).click();await expect(page.locator('.desktop-create-operation')).toContainText('已创建');
  expect(f.requests.find(r=>r.url.endsWith('/apply')).input.request.input.text).toBe('看看这篇文章\nhttps://example.com/article\n请提炼重点');
  await page.evaluate(()=>{view.create.stop();view.openCreate();});await expect(input).toHaveValue('');expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);
 }finally{await f.close();}
});
test('share receive failure stays visible on the open create pane through refresh without touching input',async({page})=>{
 const f=await fixture(page);try{
  await prepare(page);const input=page.getByLabel('内容',{exact:true});await input.focus();
  await page.evaluate(()=>{
   window.originalInput=view.create.draftInput;window.shareRetryCount=0;window.__ashShareText={flush(){shareRetryCount++;}};
   originalInput.setSelectionRange(2,5);view.sharedDrafts.bind(net.currentScope);
   view.sharedDrafts.saved.clear();view.sharedDrafts.saved.set('original-destination','原草稿');view.sharedDrafts.saved.set('share-destination','分享草稿');
  });
  expect(await page.evaluate(()=>view.receiveShare({id:'overflow',text:'https://example.com/article'}))).toBe(false);
  await expect(page.locator('.desktop-create .desktop-share-notice')).toContainText('暂时无法接收');
  await expect(page.locator('.desktop-create').getByRole('button',{name:'重试接收',exact:true})).toBeVisible();
  await page.evaluate(()=>view.create.refresh());
  await expect(page.locator('.desktop-create').getByRole('button',{name:'重试接收',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>[view.create.draftInput===originalInput,document.activeElement===originalInput,originalInput.value,originalInput.selectionStart,originalInput.selectionEnd])).toEqual([true,true,'private first input',2,5]);
  await page.locator('.desktop-create').getByRole('button',{name:'重试接收',exact:true}).click();expect(await page.evaluate(()=>shareRetryCount)).toBe(1);expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);
 }finally{await f.close();}
});

test('ordinary new-project draft restores after reload and clears only on explicit create',async({page})=>{
 const f=await fixture(page);try{
  await prepare(page);await page.getByLabel('内容',{exact:true}).fill('尚未发送的新建草稿');await f.mount();await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await expect(page.getByLabel('内容',{exact:true})).toHaveValue('尚未发送的新建草稿');expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);
  await page.getByRole('button',{name:'创建',exact:true}).click();await expect.poll(()=>f.requests.filter(r=>r.url.endsWith('/apply')).length).toBe(1);
  await f.mount();await page.getByRole('button',{name:'新建会话',exact:true}).click();await expect(page.getByLabel('内容',{exact:true})).toHaveValue('');expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);
 }finally{await f.close();}
});

test('create operation storage failure preserves project draft and prevents apply',async({page})=>{
 const f=await fixture(page);try{
  await prepare(page);await page.evaluate(()=>{view.create.store.storage={getItem(){return null;},setItem(){throw Error('full');}};});await page.getByRole('button',{name:'创建',exact:true}).click();
  await expect(page.locator('.desktop-create')).toContainText('稍后再发送');expect(f.requests.some(r=>r.url.endsWith('/apply'))).toBe(false);await expect(page.getByLabel('内容',{exact:true})).toHaveValue('private first input');
 }finally{await f.close();}
});
for(const mode of ['unknown','name-fail'])test(`submitted create text survives ${mode} and reload only queries its original operation`,async({page})=>{
 const f=await fixture(page,mode);try{
  await prepare(page);await page.getByRole('button',{name:'创建',exact:true}).click();await expect.poll(()=>f.requests.filter(r=>r.url.endsWith('/apply')).length).toBe(1);
  await expect(page.getByLabel('内容',{exact:true})).toHaveValue('');await f.mount();await page.getByRole('button',{name:'新建会话',exact:true}).click();await expect(page.locator('.desktop-create-operation')).toHaveCount(1);
  await page.locator('.desktop-create-operation summary').click();await expect(page.locator('.desktop-create-operation .desktop-text')).toHaveText('private first input');await expect(page.getByLabel('内容',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'查询结果',exact:true}).click();expect(f.requests.filter(r=>r.url.endsWith('/apply'))).toHaveLength(1);expect(f.requests.filter(r=>r.url.endsWith('/query')).every(r=>!r.input.input&&!r.input.title)).toBe(true);
  if(mode==='unknown'){f.acceptSaved();await page.getByRole('button',{name:'查询结果',exact:true}).click();await expect(page.locator('.desktop-create-operation')).toContainText('消息：已确认');await expect(page.locator('.desktop-create-operation .desktop-text')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('ash.desktop.create-outbox.v1'))).not.toContain('private first input');}
 }finally{await f.close();}
});

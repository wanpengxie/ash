import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
let server,browser,base;
before(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(!/^\/(index\.html|component\.(css|js)|host\.(css|js)|avatars\/\w+\.webp)$/.test(path)){res.writeHead(404).end();return;}
    res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.webp')?'image/webp':'text/html');
    res.end(readFileSync(new URL('../android/app/src/main/assets/ash-island'+path,import.meta.url)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close(); await new Promise(resolve=>server?.close(resolve));});
const normal={session:'s',turn:'t_a',kind:'working',reply:'',cards:[],elapsed:35,activity:'在看网页',canStop:true,interactive:true,mayClose:false,
  cardWidth:362,maxHeight:650,reduceMotion:true,stale:false,notice:''};
const card={id:'m_a',kind:'approval',state:'waiting',title:'要发给小李',detail:'发送以下内容',original:'第一行\n'+ '原文'.repeat(3000)+'\n尾部',
  options:[{id:'once',label:'允许这一次'},{id:'deny',label:'不允许'}],allow_custom:false,localState:''};
async function page(model=normal){
  const p=await browser.newPage({viewport:{width:410,height:844}});
  await p.addInitScript(()=>{window.messages=[]; window.AshIslandNative={postMessage:raw=>window.messages.push(JSON.parse(raw))};});
  await p.goto(base+'/index.html'); await p.waitForFunction(()=>window.AshIsland);
  await p.evaluate(m=>window.AshIsland.receive(m),model); return p;
}
test('designer geometry, current action and reference palette; close is not stop',async()=>{
  const p=await page();
  try{
    assert.equal(await p.locator('.isl').evaluate(e=>e.getBoundingClientRect().width),236);
    assert.equal(await p.locator('.isl').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(16, 16, 17)');
    await p.locator('[data-act=tap]').click(); assert.equal(await p.locator('.isl').evaluate(e=>e.getBoundingClientRect().width),362);
    assert.equal(await p.locator('.activity b').textContent(),'在看网页');
    await p.screenshot({path:'/tmp/ash-island-working.png'});
    await p.locator('[data-act=close]').click(); assert.equal(await p.locator('.isl').getAttribute('data-form'),'compact');
    assert.equal(await p.evaluate(()=>messages.some(m=>['stop','answer','dismiss'].includes(m.action))),false);
    await p.locator('[data-act=tap]').click(); await p.locator('[data-act=stop]').click();
    assert.equal(await p.evaluate(()=>messages.at(-1).action),'stop');
  }finally{await p.close();}
});
test('exact approval, full original, pending close only collapses and answered cannot repeat',async()=>{
  const p=await page({...normal,canStop:false,cards:[card]});
  try{
    assert.equal(await p.locator('.isl').getAttribute('data-form'),'card');
    await p.screenshot({path:'/tmp/ash-island-approval.png'});
    await p.locator('[data-act=original]').click(); assert.equal(await p.locator('.original').textContent(),card.original);
    await p.locator('[data-act=original]').click(); await p.locator('[data-act=allow]').click();
    assert.deepEqual(await p.evaluate(()=>messages.filter(m=>m.action==='answer').at(-1)),{action:'answer',turn:'t_a',requestId:'m_a',choice:'once'});
    await p.locator('[data-act=close]').click(); assert.equal(await p.locator('.isl').getAttribute('data-form'),'compact');
    await p.locator('[data-act=tap]').click();
    await p.evaluate(m=>AshIsland.receive(m),{...normal,canStop:false,cards:[{...card,state:'answered'}],mayClose:true});
    assert.equal(await p.locator('.ap-approved').count(),1); assert.equal(await p.locator('[data-act=allow]').count(),0);
    await p.locator('[data-act=close]').click(); assert.equal(await p.evaluate(()=>messages.filter(m=>m.action==='dismiss').length),1);
  }finally{await p.close();}
});
test('clock and state updates preserve the input node, focus, selection and draft',async()=>{
  const p=await page({...normal,kind:'reply',reply:'需要补充哪一项？',canStop:false,mayClose:true});
  try{
    const input=p.locator('input'); await input.fill('还没写完的草稿');
    await p.evaluate(()=>{window.savedInput=document.querySelector('input'); savedInput.focus(); savedInput.setSelectionRange(2,4);});
    for(const elapsed of [40,45,50]) await p.evaluate(m=>AshIsland.receive(m),{...normal,kind:'reply',reply:'需要补充哪一项？',canStop:false,mayClose:true,elapsed});
    await p.evaluate(m=>AshIsland.receive(m),{...normal,kind:'reply',reply:'新的回复，草稿不能丢',canStop:false,mayClose:true});
    assert.deepEqual(await p.evaluate(()=>({same:savedInput===document.querySelector('input'),focus:document.activeElement===savedInput,value:savedInput.value,start:savedInput.selectionStart})),
      {same:true,focus:true,value:'还没写完的草稿',start:2});
    await p.locator('[data-act=send]').click(); assert.equal(await p.evaluate(()=>messages.filter(m=>m.action==='send').at(-1).text),'还没写完的草稿');
    await p.evaluate(()=>AshIsland.sent(false,'发送未确认')); assert.equal(await input.inputValue(),'还没写完的草稿');
    await p.evaluate(()=>AshIsland.sent(true,'已发送')); assert.equal(await input.inputValue(),'');
  }finally{await p.close();}
});
test('old settled approvals cannot obscure a new question, resumed work, or the final reply',async()=>{
  const p=await page({...normal,cards:[card]});
  const settled={...card,state:'answered'};
  try{
    const newer={...card,id:'m_b',title:'第二次审批'};
    await p.evaluate(m=>AshIsland.receive(m),{...normal,cards:[settled,newer]});
    assert.match(await p.locator('.body').textContent(),/第二次审批/);
    await p.evaluate(m=>AshIsland.receive(m),{...normal,cards:[settled]});
    assert.equal(await p.locator('.activity b').textContent(),'在看网页');
    const final={...normal,kind:'reply',canStop:false,mayClose:true,reply:'任务的最后回复',cards:[settled]};
    await p.evaluate(m=>AshIsland.receive(m),final);
    await p.evaluate(m=>AshIsland.receive(m),{...final,elapsed:40});
    assert.equal(await p.locator('.body').textContent(),'任务的最后回复');
    assert.equal(await p.locator('[data-act=allow],.island-nav').count(),0);
  }finally{await p.close();}
});
test('untrusted reply is inert; questions use exact ids; expired and stale are not actionable',async()=>{
  const q={...card,kind:'ask',options:[{id:'option-7',label:'方案 A'},{id:'option-8',label:'方案 A'}],allow_custom:true,title:'<img src=x onerror=alert(1)>'};
  const p=await page({...normal,canStop:false,cards:[q]});
  try{
    assert.equal(await p.locator('.island-content img').count(),0);
    await p.locator('[data-act=choose]').nth(1).click(); assert.equal(await p.evaluate(()=>messages.filter(m=>m.action==='answer').at(-1).choice),'option-8');
    await p.locator('input').fill('自定义回答'); await p.locator('[data-act=send]').click();
    assert.equal(await p.evaluate(()=>messages.filter(m=>m.action==='send').at(-1).requestId),'m_a');
    await p.evaluate(()=>AshIsland.sent(true,'已回答'));
    await p.locator('input').fill('尚未提交的回答');
    await p.evaluate(m=>AshIsland.receive(m),{...normal,canStop:false,cards:[{...q,state:'expired'}]});
    assert.equal(await p.locator('[data-act=choose]').count(),0);
    await p.locator('[data-act=send]').click();
    assert.equal(await p.evaluate(()=>messages.filter(m=>m.action==='send').at(-1).requestId),'m_a','expired question draft must not become ordinary input');
    await p.evaluate(m=>AshIsland.receive(m),{...normal,stale:true,interactive:false,canStop:false,cards:[card]});
    assert.equal(await p.locator('[data-act=allow],[data-act=stop]').count(),0);
  }finally{await p.close();}
});

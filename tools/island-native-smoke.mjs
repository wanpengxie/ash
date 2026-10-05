// Isolated mini emulator only. Native taps + IME + real owner routing; echo uses no model keys.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adb=`${homedir()}/Library/Android/sdk/platform-tools/adb`, pkg='ai.ash.agent.probe';
const shell=(...args)=>execFileSync(adb,['shell',...args],{encoding:'utf8'}).trim();
const out=process.env.ASH_ISLAND_EVIDENCE; assert.ok(out); mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(fn,label,timeout=30000)=>{ const until=Date.now()+timeout; while(Date.now()<until){ try{const v=await fn();if(v)return v;}catch{} await sleep(250); } throw Error(`timeout: ${label}`); };
const overridePath=`/data/user/0/${pkg}/files/ash/config.override.json`, original=shell('cat',overridePath);
const originalScreenTimeout=shell('settings','get','system','screen_off_timeout');
const a11y=`${pkg}/ai.ash.host.a11y.A11yService`;
const services=()=>shell('settings','get','secure','enabled_accessibility_services').split(':').filter(s=>s&&s!=='null');
const hadA11y=services().includes(a11y);
const push=value=>{const path=out+'/probe-config.json';writeFileSync(path,value,{mode:0o600});execFileSync(adb,['push',path,overridePath],{stdio:'ignore'});};
const shot=name=>writeFileSync(`${out}/${name}.png`,execFileSync(adb,['exec-out','screencap','-p']));
let cfg,token,ws,heartbeat,ready=false,sequence=0,turn,cards=[],state='working',reply='',revision=0;
const session=`island-smoke-${Date.now()}`,started=Date.now();
const request=async(port,path,body,auth,allowError=false)=>{
  const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!r.ok&&!allowError)throw Error(`HTTP ${r.status}`); return path.includes('/stream')?r.text():r.json();
};
const send=body=>request(14763,'/api/send',body,token);
const rows=async()=>(await request(14763,'/api/stream?follow=false&limit=1000',undefined,token)).split('\n').filter(l=>l.startsWith('data:'))
  .map(l=>JSON.parse(l.slice(5))).filter(m=>m.word);
const frame=()=>request(14764,'/task/status',{session,revision:++revision,turn,started_at:started,state,
  text:state==='working'?'在查找订单 · PRIVATE_QUERY':state==='waiting_you'?'等待你回应':'本轮回复',steps:['不可出现在展开卡片里的历史'],
  can_stop:state==='working',outcome:state==='done'?'completed':'',reply,cards},cfg.host.token);
const win=()=>shell('dumpsys','window','windows').split(/(?=  Window #\d+ Window\{)/)
  .find(w=>/Window\{[^\n]*AshTaskCapsule/.test(w)&&w.includes(`package=${pkg} `)&&w.includes('isVisible=true'));
const bounds=()=>{const m=win()?.match(/frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);assert.ok(m,'island window');return m.slice(1).map(Number);};
const pending=new Map();let callId=0;
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++callId;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,'CDP expression');return r.result?.value;};
const markerPixels=async base64=>evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));const bmp=await createImageBitmap(new Blob([bytes]));const canvas=new OffscreenCanvas(bmp.width,bmp.height),ctx=canvas.getContext('2d');ctx.drawImage(bmp,0,0);const p=ctx.getImageData(0,0,bmp.width,bmp.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]>210&&p[i+1]<80&&p[i+2]>210)n++;bmp.close();return n;})()`);
const settled=async()=>{await wait(()=>evaluate(`document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState==='finished')`),'layout animation settled');await sleep(500);};
const tap=async selector=>{
  await settled();
  const r=await wait(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}:null})()`),'tap '+selector);
  const [l,t,right]=bounds(),scale=(right-l)/r.width;
  shell('input','tap',String(Math.round(l+r.x*scale)),String(Math.round(t+r.y*scale)));await sleep(1000);
};
const rendered=async text=>wait(()=>evaluate(`document.querySelector('.isl').textContent.includes(${JSON.stringify(text)})`),'render '+text);
// Android gives one bulk `input text` invocation a shared event timestamp. A busy emulator
// drops its tail as stale; small native chunks avoid that instrumentation-only time limit.
const typeNative=async text=>{let expected='';for(const chunk of text.match(/.{1,4}/g)||[]){
  shell('input','text',chunk);expected+=chunk;
  await wait(()=>evaluate(`document.querySelector('input').value===${JSON.stringify(expected)}`),'native input chunk');
}};
const seed=async text=>{
  const result=await send({to:'agent:main',kind:'request',word:'say',body:{text},wait:true});
  return wait(async()=>{const all=await rows(),start=all.find(m=>m.word==='turn.start'&&m.body.ids?.includes(result.id));
    return start&&all.some(m=>m.word==='turn.end'&&m.body.turn===start.body.turn)&&start.body.turn;},'echo turn');
};
const makeCard=async(kind='approval')=>{
  const title=(kind==='question'?'请选择方案':'测试审批')+' #'+(++sequence);
  const body={title,detail:'只验证交互，不执行外部操作',source:{word:'fixture',to:'person:owner',body_preview:'测试',body_full:'完整原文\n'+ '正文'.repeat(900)+'\nTAIL'},
    options:kind==='question'?[{id:'a',label:'方案 A'},{id:'b',label:'方案 B'}]:[{id:'once',label:'允许这一次'},{id:'deny',label:'拒绝'}],
    expires_at:Date.now()+600000,...(kind==='question'?{human_kind:'question',allow_custom:true}:{})};
  const ask=await send({to:'person:owner',kind:'request',word:'ask',body,wait:false});
  // Android's existing confirmation heads-up is above application overlays. Let it retract
  // before native coordinate taps, so the test never clicks the notification's Open-Ash action.
  await sleep(7000);
  return {id:ask.id,pending_id:ask.id,to:'person:owner',turn,kind,...body,original:body.source.body_full,allow_custom:kind==='question',state:'waiting'};
};
const answer=async card=>wait(async()=>(await rows()).find(m=>m.kind==='response'&&m.reply_to===card.id),'exact ask response');
try{
  shell('settings','put','system','screen_off_timeout','1800000');shell('input','keyevent','KEYCODE_WAKEUP');shell('wm','dismiss-keyguard');
  shell('am','force-stop',pkg);push(JSON.stringify({...JSON.parse(original),agents:[{id:'agent:main',name:'Ash',runtime:'echo'}]}));
  shell('am','start','-n',`${pkg}/ai.ash.ui.HomeActivity`);
  for(const port of [14763,14764])execFileSync(adb,['forward',`tcp:${port}`,`tcp:${port}`]);
  await wait(async()=>{cfg=JSON.parse(shell('cat',`/data/user/0/${pkg}/files/ash/ash.json`));
    token=shell('cat',`/data/user/0/${pkg}/files/ash/state/ui-url`).match(/token=([^\s]+)/)[1];
    return request(14763,'/api/describe',undefined,token);},'probe ready',420000);
  ready=true; console.log('Probe ready');
  shell('settings','put','secure','enabled_accessibility_services',[...new Set([...services(),a11y])].join(':'));
  shell('settings','put','secure','accessibility_enabled','1');
  await wait(async()=>{const r=await request(14764,'/call',{capability:'screen.read',args:{}},cfg.host.token);return r.ok;},'probe accessibility bound');
  const pid=shell('pidof',pkg);execFileSync(adb,['forward','tcp:14765',`localabstract:webview_devtools_remote_${pid}`]);
  const target=await wait(async()=>(await(await fetch('http://127.0.0.1:14765/json/list')).json()).find(t=>t.url==='https://appassets.androidplatform.net/assets/ash-island/index.html'),'local island WebView');
  ws=new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error('CDP error')):p.resolve(m.result);});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  await call('Runtime.enable'); await evaluate('window.islandProbeNonce="reused-webview"');
  await sleep(7000); // restored heads-up notifications must retract before coordinate taps
  turn=await seed('island fixture '+started);
  shell('am','start','-n','com.google.android.deskclock/com.android.deskclock.DeskClock'); await sleep(700);
  await frame(); heartbeat=setInterval(()=>frame().catch(()=>{}),4000);
  await wait(()=>win(),'visible island'); await rendered('在查找订单');await settled();
  assert.equal(await evaluate('document.querySelector(".isl").dataset.form'),'compact');
  assert.equal(await evaluate('document.querySelector(".isl").getBoundingClientRect().width'),236);shot('compact');
  await tap('[data-act=tap]');await rendered('停止任务');await settled();
  assert.equal(await evaluate('document.querySelector(".isl").getBoundingClientRect().width'),362);
  assert.equal(await evaluate('document.body.textContent.includes("PRIVATE_QUERY")||document.body.textContent.includes("不可出现在")'),false);shot('working');
  if(!process.env.ASH_ISLAND_CAPTURE_ONLY){
  await tap('input');
  await wait(()=>shell('dumpsys','window','windows').split(/(?=  Window #\d+ Window\{)/).some(w=>/Window\{[^\n]* InputMethod\}/.test(w)&&w.includes('isVisible=true')),'IME on overlay');
  await evaluate(`window.inputProbe=[];document.addEventListener('input',e=>inputProbe.push([e.type,e.target.value]),true);document.addEventListener('focusout',e=>inputProbe.push([e.type,e.target.tagName]),true)`);
  const text=`island_input_${started}`;await typeNative(text);
  await wait(()=>evaluate(`document.querySelector('input').value===${JSON.stringify(text)}`),'complete native input');
  await frame();await sleep(1200);assert.equal(await evaluate('document.querySelector("input").value'),text);shot('input');
  const blocked=await request(14764,'/call',{capability:'screen.see',args:{}},cfg.host.token,true);
  assert.match(JSON.stringify(blocked),/owner_input_busy/);
  await tap('[data-act=send]');
  await wait(async()=>(await rows()).some(m=>m.from==='person:owner'&&m.word==='say'&&m.body.text===text),'ordinary owner input');
  console.log('PASS: native IME / draft / ordinary owner input / capture busy guard');
  turn=await seed('island reply '+started); state='done';reply='已经找到两个方案。\n\n你想选 A 还是 B？';await frame();await rendered('你想选 A');shot('reply');
  await tap('[data-act=close]');await wait(()=>!win(),'settled reply hidden');
  turn=await seed('island approval '+started);state='waiting_you';reply='';cards=[await makeCard()];await frame();await rendered(cards[0].title);
  await tap('[data-act=close]');assert.equal(await evaluate('document.querySelector(".isl").dataset.form'),'compact');
  assert.equal((await rows()).some(m=>m.kind==='response'&&m.reply_to===cards[0].id),false);
  await tap('[data-act=tap]');await tap('[data-act=original]');
  await wait(()=>evaluate('!!document.querySelector(".original")'),'expanded original');
  assert.equal(await evaluate('document.querySelector(".original").textContent'),cards[0].original);shot('original');
  await tap('[data-act=original]');await tap('[data-act=allow]');assert.equal((await answer(cards[0])).body.result.choice,'once');
  await rendered('已批准，等待继续');shot('approved');
  cards=[await makeCard()];await frame();await rendered(cards[0].title);await tap('[data-act=deny]');assert.equal((await answer(cards[0])).body.result.choice,'deny');
  cards=[await makeCard('question')];await frame();await rendered(cards[0].title);await tap('[data-act=custom]');
  await typeNative('island_custom_answer');await tap('[data-act=send]');assert.equal((await answer(cards[0])).body.result.text,'island_custom_answer');
  cards=[{...cards[0],state:'expired'}];await frame();await rendered('已过期');assert.equal(await evaluate('!!document.querySelector("[data-act=choose],[data-act=custom]")'),false);
  console.log('PASS: IME / draft / ordinary input / pending close / original / approve / deny / formal custom answer / expiry');
  }
  cards=[];state='working';reply='';await frame();await sleep(700);
  const read=await request(14764,'/call',{capability:'screen.read',args:{}},cfg.host.token);
  assert.match(JSON.stringify(read),/com.google.android.deskclock/);assert.doesNotMatch(JSON.stringify(read),/Ash 任务状态|停止任务|回复 Ash/);
  await evaluate(`(()=>{const marker=document.createElement('div');marker.id='capture-probe';marker.style='position:fixed;left:64px;top:0;width:96px;height:24px;background:#ff00ff;z-index:9999;pointer-events:none';document.body.append(marker);})()`);
  await sleep(1000);
  const control=execFileSync(adb,['exec-out','screencap','-p']);writeFileSync(out+'/capture-control.png',control);
  assert.ok(await markerPixels(control.toString('base64'))>500,'positive control: marker is visible in native screenshot');
  const image=await request(14764,'/call',{capability:'screen.see',args:{}},cfg.host.token);
  assert.equal(image.ok,true);const captured=image.content.find(c=>c.type==='image').data;writeFileSync(out+'/agent-screen.jpg',Buffer.from(captured,'base64'));
  const pixels=await markerPixels(captured);assert.ok(pixels<50,`agent screenshot must exclude overlay pixels (found ${pixels})`);
  await evaluate('document.getElementById("capture-probe").remove()');
  await wait(()=>win(),'restored after two-frame capture');
  assert.equal(await evaluate('window.islandProbeNonce'),'reused-webview');
  const before=await evaluate('document.querySelector(".isl").dataset.form'),[l,t,r]=bounds();
  await request(14764,'/call',{capability:'screen.tap',args:{x:(l+r)/2,y:t+30}},cfg.host.token);
  assert.equal(await evaluate('document.querySelector(".isl").dataset.form'),before,'automation tap must pass through');
  if(before==='compact')await tap('[data-act=tap]');
  await tap('[data-act=open]');await wait(()=>!win(),'hidden in Ash');
  shell('am','start','-n','com.google.android.deskclock/com.android.deskclock.DeskClock');await wait(()=>win(),'available outside Ash again');
  clearInterval(heartbeat);heartbeat=null;await sleep(17000);await rendered('连接中断');
  assert.equal(await evaluate('!!document.querySelector("[data-act=stop],[data-act=allow]")'),false);shot('stale');
  assert.equal(await evaluate('window.islandProbeNonce'),'reused-webview');
  console.log('PASS: local WebView reuse / native window sizing / screenshot exclusion / touch passthrough / return to Ash / stale guard');
}catch(error){
  console.error(error);
  shot('failure');
  if(ws?.readyState===1)console.log('Input diagnostic',await evaluate('JSON.stringify({events:window.inputProbe,active:document.activeElement.tagName,value:document.querySelector("input")?.value})'));
  throw error;
}finally{
  if(heartbeat)clearInterval(heartbeat);ws?.close();
  if(ready)shell('am','force-stop',pkg);push(original);
  if(ready)shell('am','start','-n',`${pkg}/ai.ash.ui.HomeActivity`);
  if(originalScreenTimeout==='null')shell('settings','delete','system','screen_off_timeout');else shell('settings','put','system','screen_off_timeout',originalScreenTimeout);
  if(!hadA11y){const remaining=services().filter(s=>s!==a11y);
    if(remaining.length)shell('settings','put','secure','enabled_accessibility_services',remaining.join(':'));else shell('settings','delete','secure','enabled_accessibility_services');
    if(!remaining.length)shell('settings','put','secure','accessibility_enabled','0');}
}

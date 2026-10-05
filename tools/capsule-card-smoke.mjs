// Isolated Android acceptance. Uses echo (no model key), real router ask responses and native touches.
// Run on the mini after installing the isolated probe APK. Never touches ai.ash.agent or its vault.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adb = `${homedir()}/Library/Android/sdk/platform-tools/adb`, pkg = 'ai.ash.agent.probe';
const exec = promisify(execFile);
const shell = (...args) => execFileSync(adb, ['shell', ...args], { encoding: 'utf8' }).trim();
const out = process.env.ASH_CAPSULE_EVIDENCE;
assert.ok(out, 'provide a task-specific evidence directory'); mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, timeout=30000) => { const end=Date.now()+timeout; while(Date.now()<end) { try { const result=await fn(); if(result) return result; } catch {} await sleep(300); } throw Error(`timeout: ${label}`); };
const overridePath = `/data/user/0/${pkg}/files/ash/config.override.json`;
const original = shell('cat', overridePath);
const pushText = (value, target) => { const file=`${out}/probe-config.json`; writeFileSync(file,value,{mode:0o600}); execFileSync(adb,['push',file,target],{stdio:'ignore'}); };
let cfg, token;
const request = async (port, path, body, auth) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET',
    headers:{authorization:`Bearer ${auth}`, 'content-type':'application/json'}, body:body ? JSON.stringify(body):undefined, signal:AbortSignal.timeout(10000) });
  if(!response.ok) throw Error(`HTTP ${response.status}`);
  return path.includes('/stream') ? response.text() : response.json();
};
const send = body => request(14763,'/api/send',body,token);
const rows = async () => (await request(14763,'/api/stream?follow=false&limit=1000',undefined,token))
  .split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5))).filter(m=>m.word);
const win = () => shell('dumpsys','window','windows').split(/(?=  Window #\d+ Window\{)/).find(w=>/Window\{[^\n]*AshTaskCapsule/.test(w)&&w.includes(`package=${pkg} `)&&w.includes('isVisible=true'));
const bounds = () => { const w=win(), m=w?.match(/(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if(!m) writeFileSync(`${out}/window-debug.txt`,w??shell('dumpsys','window','windows'));
  assert.ok(m,'capsule visible'); return m.slice(1).map(Number); };
const tap = (x,y) => shell('input','tap',String(Math.round(x)),String(Math.round(y)));
const screenshot = name => writeFileSync(`${out}/${name}.png`,execFileSync(adb,['exec-out','screencap','-p']));
// UIAutomator can exit 0 without writing when it cannot reach idleness. Never read an older dump.
let dumpNumber=0;
const xml = async () => {
  const path=`/data/local/tmp/ash-card-ui-${started}-${++dumpNumber}.xml`;
  const result=await exec(adb,['shell','uiautomator','dump',path]);
  assert.ok(result.stdout.includes(`dumped to: ${path}`),'fresh UI hierarchy');
  return shell('cat',path);
};
const tapLabel = async label => {
  const node=await wait(async()=> {
    const tree=await xml();
    writeFileSync(`${out}/latest-ui.xml`,tree);
    if(cards[0] && !tree.includes(`text="${cards[0].title}"`)) return;
    return tree.match(/<node\b[^>]*>/g)?.find(n=>n.includes(`text="${label}"`)&&n.includes('enabled="true"'));
  },`enabled current button ${label}`);
  const b=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number); tap((b[0]+b[2])/2,(b[1]+b[3])/2);
};
let revision=0, turn, cards=[], reply='这是完整回复。\n\n你希望选择 A 还是 B？', state='done';
const session=`capsule-cards-${Date.now()}`, started=Date.now();
const inputText=`capsule_input_${started}`;
let cardNumber=0;
const frame = () => {
  // Keep this synthetic display's elapsed label at zero, so UIAutomator can settle.
  // Approval expiry and freshness still use real time; the real core turn id is unchanged.
  const payload={session,revision:++revision,turn,started_at:started+3600000,state,
    text:state==='waiting_you'?'等待你回应':'本轮回复',steps:['已读取目标页面'],can_stop:false,outcome:'completed',reply,cards};
  writeFileSync(`${out}/expected-frame.json`,JSON.stringify(payload,null,2));
  return request(14764,'/task/status',payload,cfg.host.token);
};
let heartbeat, ready=false;
try {
  const override={...JSON.parse(original),agents:[{id:'agent:main',name:'Ash',runtime:'echo'}]};
  shell('am','force-stop',pkg); pushText(JSON.stringify(override),overridePath);
  shell('am','start','-n',`${pkg}/ai.ash.ui.HomeActivity`);
  execFileSync(adb,['forward','tcp:14763','tcp:14763']); execFileSync(adb,['forward','tcp:14764','tcp:14764']);
  await wait(async()=>{ cfg=JSON.parse(shell('cat',`/data/user/0/${pkg}/files/ash/ash.json`));
    token=shell('cat',`/data/user/0/${pkg}/files/ash/state/ui-url`).match(/token=([^\s]+)/)[1];
    return request(14763,'/api/describe',undefined,token); },'probe ready',240000);
  console.log('Probe ready (echo runtime)');
  ready=true;
  const seed=await send({to:'agent:main',kind:'request',word:'say',body:{text:'capsule acceptance fixture'},wait:true});
  turn=await wait(async()=>{const all=await rows(); const start=all.find(m=>m.word==='turn.start'&&m.body.ids?.includes(seed.id));
    return start&&all.some(m=>m.word==='turn.end'&&m.body.turn===start.body.turn)&&start.body.turn;},'echo turn');
  shell('am','start','-n','com.google.android.deskclock/com.android.deskclock.DeskClock'); await sleep(1000); await frame(); await sleep(1000); await wait(()=>win(),'reply capsule');
  screenshot('reply');
  // Footer input acquires focus, enabling real UIAutomator inspection of this native overlay.
  const focus=async()=>{ await sleep(700); if(!win()?.includes('NOT_FOCUSABLE')) return;
    const [l,t,r,b]=bounds(); tap(l+(r-l)/6,b-60); await sleep(700); };
  await focus();
  const replyTree=await xml(); assert.match(replyTree,/你希望选择 A 还是 B/); assert.match(replyTree,/text="回 Ash"/); assert.match(replyTree,/text="结束"/);
  shell('input','text',inputText); await tapLabel('发送');
  await wait(async()=> (await rows()).some(m=>m.from==='person:owner'&&m.word==='say'&&m.body.text===inputText),'native input in ledger');
  console.log('PASS: native input reached the owner ledger');
  // Use that actual latest turn for the end-button fence, not a fabricated turn id.
  turn=await wait(async()=>{const all=await rows(), message=all.find(m=>m.from==='person:owner'&&m.body.text===inputText);
    const start=all.find(m=>m.word==='turn.start'&&m.body.ids?.includes(message?.id));
    return start&&all.some(m=>m.word==='turn.end'&&m.body.turn===start.body.turn)&&start.body.turn;},'input turn ended');
  const makeCard=async(kind='approval',expires=Date.now()+600000)=>{
    const body={title:`${kind==='question'?'请选择方案':'测试审批（不执行外部操作）'} #${++cardNumber}`,detail:'仅验证卡片及答复路由',
      source:{word:'fixture',to:'person:owner',body_preview:'测试',body_full:'完整原文\n尾部：不可省略'},
      options:kind==='question'?[{id:'a',label:'选 A'},{id:'b',label:'选 B'}]:[{id:'once',label:'允许这一次'},{id:'deny',label:'拒绝'}],expires_at:expires,
      ...(kind==='question'?{human_kind:'question',allow_custom:true}:{})};
    const ask=await send({to:'person:owner',kind:'request',word:'ask',body,wait:false});
    console.log(`Fixture ${kind}: ${ask.id}`);
    return {id:ask.id,pending_id:ask.id,to:'person:owner',turn,kind,...body,original:'完整原文\n尾部：不可省略',allow_custom:kind==='question',state:'waiting'};
  };
  reply=''; state='waiting_you'; cards=[await makeCard()]; await frame();
  heartbeat=setInterval(()=>frame().catch(()=>{}),4000);
  await focus(); await tapLabel('查看原文'); assert.match(await xml(),/尾部：不可省略/); screenshot('approval-original');
  await tapLabel('收起原文'); await tapLabel('允许并继续');
  const approved=await wait(async()=>(await rows()).find(m=>m.kind==='response'&&m.reply_to===cards[0].id),'approval answer');
  assert.equal(approved.body.result.choice,'once'); assert.equal(approved.origin.screen,'device:phone');
  assert.match(await xml(),/已批准，等待继续/); screenshot('approved');
  console.log('PASS: exact approval response and full original');
  shell('input','keyevent','4');
  cards=[await makeCard()]; await frame(); await focus(); await tapLabel('拒绝');
  assert.equal((await wait(async()=>(await rows()).find(m=>m.kind==='response'&&m.reply_to===cards[0].id),'denial')).body.result.choice,'deny');
  shell('input','keyevent','4');
  cards=[await makeCard('question')]; await frame(); await focus(); await tapLabel('输入回答');
  shell('input','text','custom_card_answer'); await tapLabel('发送');
  const answered=await wait(async()=>(await rows()).find(m=>m.kind==='response'&&m.reply_to===cards[0].id),'custom answer');
  assert.equal(answered.body.result.choice,'custom'); assert.equal(answered.body.result.text,'custom_card_answer');
  cards=[{...cards[0],state:'expired'}]; await frame(); await focus();
  const expiredTree=await xml(); assert.match(expiredTree,/已过期/); assert.doesNotMatch(expiredTree,/text="输入回答"/); screenshot('expired');
  shell('input','keyevent','4'); clearInterval(heartbeat); heartbeat=null;
  cards=[];state='done';reply='本轮结束，回复仍然保留。';await frame(); await focus(); await tapLabel('结束');
  await wait(()=>!win(),'explicit end hides capsule');
  assert.ok((await rows()).some(m=>m.word==='task.end'&&m.kind==='response'&&m.body.result?.ended===true));
  console.log('PASS: reply / fixed buttons / native input / full original / approve / deny / contextual answer / expiry / end');
} finally {
  if(heartbeat) clearInterval(heartbeat);
  if(ready) shell('am','force-stop',pkg);
  pushText(original,overridePath);
  if(ready) shell('am','start','-n',`${pkg}/ai.ash.ui.HomeActivity`);
}

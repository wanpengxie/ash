// Real WebView/native bridge; only conversation selection/net metadata are fixture.
import {readFileSync,writeFileSync} from 'node:fs';
const dir='build/result-file-android-local-20261012';
const pages=await(await fetch('http://127.0.0.1:19223/json')).json();
const target=pages.find(p=>p.url.includes('appassets.androidplatform.net/assets/ash-ui/index.html'));
if(!target)throw Error('isolated WebView page missing');
const ws=new WebSocket(target.webSocketDebuggerUrl),waiting=new Map();let id=0;
await new Promise((yes,no)=>{ws.onopen=yes;ws.onerror=no;});
ws.onmessage=event=>{const p=JSON.parse(event.data);const done=waiting.get(p.id);if(done){waiting.delete(p.id);done(p);}};
const command=(method,params)=>new Promise(resolve=>{const n=++id;waiting.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression)=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.error||r.result?.exceptionDetails)throw Error(JSON.stringify(r.error||r.result.exceptionDetails));return r.result?.result?.value;};
const page={async addScriptTag({content}){await evaluate(content);},async evaluate(fn,arg){return evaluate('('+fn.toString()+')('+JSON.stringify(arg)+')');}};
const action=process.argv[2]||'inject';
if(action==='inject'){
 const ready=JSON.parse(readFileSync(`${dir}/fixture-ready.json`,'utf8'));
 await page.addScriptTag({content:readFileSync(`${dir}/view.js`,'utf8')});
 await page.evaluate(ready=>{
  if(typeof __ashResultFileSave!=='function'||typeof AshNative?.postMessage!=='function')throw Error('real native bridge absent');
  window.AndroidResultProbeBridge=__ashResultFileSave;
  document.body.innerHTML='<section id="android-result-probe"></section>';
  const root=document.querySelector('#android-result-probe'),controlRoot=document.createElement('div');
  const target={device_id:'device:pc',node_id:'pc',endpoint_id:'pc',authorization_generation:1,authorization_revision:'a'.repeat(64)};
  const work={node_id:'pc',endpoint_id:'pc',kind:'conversation',native_id:'fixture'};
  const net={endpoint:'isolated-local-fixture',currentScope:'isolated',token:'local-result-screen',async collaborationResultFile(...args){
   if(args[2]!=='turn'||args[3]!=='assistant'||args[4]!=='./ash-native-result-20261012.md')throw Error('wrong link');return ready;
  }};
  const view=new AndroidResultProbeDesktopWork(root,net,{store:{},control:{root:controlRoot,items(){return[];},update(){return controlRoot;},stop(){return true;}}});
  view.opened=true;view.target=target;view.work=work;view.delay=3600000;
  view.entry={page:{items:[{turn_id:'turn',messages:[{role:'assistant',source_message_id:'assistant',text:'[领取本地验证结果](./ash-native-result-20261012.md)'}]}]}};
  view.refresh=async()=>{}; // no upstream gateway fixture polling
  view.render('隔离本地原生保存验证');window.AndroidResultProbeView=view;
 },ready);
}
if(action==='click')await evaluate("document.querySelector('#android-result-probe a').click()");
if(action==='status'||action==='inject'){
 const result=await page.evaluate(()=>({url:location.href,bridgeUnchanged:AndroidResultProbeBridge===__ashResultFileSave,status:document.querySelector('.desktop-result-save-status')?.textContent||'',links:document.querySelectorAll('#android-result-probe a').length,bodyHasSaveHandle:/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(document.body.textContent)}));
 console.log(JSON.stringify(result));
 if(action==='status')writeFileSync(`docs/evidence/result-file-android-local-20261012/${process.argv[3]||'status'}.json`,JSON.stringify(result,null,2)+'\n');
}
ws.close();

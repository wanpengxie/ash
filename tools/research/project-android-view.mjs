// DOM actions on the unmodified production asset page; never replaces bridge,
// picker, net responses or accepted facts. Separate process reconnects after App close.
import {writeFileSync} from 'node:fs';
let target;const targetDeadline=Date.now()+12000;while(!target&&Date.now()<targetDeadline){const pages=await(await fetch('http://127.0.0.1:19223/json')).json();target=pages.find(p=>p.url==='https://appassets.androidplatform.net/assets/ash-ui/index.html');if(!target)await new Promise(r=>setTimeout(r,100));}if(!target)throw Error('Real isolated WebView missing after bounded startup observation');
const ws=new WebSocket(target.webSocketDebuggerUrl),waiting=new Map();let id=0;await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});ws.onmessage=e=>{const p=JSON.parse(e.data),row=waiting.get(p.id);if(row){waiting.delete(p.id);clearTimeout(row.timer);p.error?row.reject(Error(JSON.stringify(p.error))):row.resolve(p);}};
const command=(method,params)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{waiting.delete(n);reject(Error('CDP deadline'));},15000);waiting.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});const evaluate=async(expression)=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
const action=process.argv[2]??'status';const button=(text)=>`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);if(!b)throw Error('Button unavailable: '+${JSON.stringify(text)});b.click();return true;})()`;
const wait=expression=>evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const check=()=>{if(${expression})resolve(true);else if(Date.now()>=end)reject(Error('Actual UI readiness unavailable: ${action}'));else setTimeout(check,50);};check();})`);
try{
 if(action==='operation-snapshot'){
  const node=process.env.ASH_PROJECT_ANDROID_NODE;if(!node)throw Error('Isolated node required');
  const operations=await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('ash.desktop-materials-metadata.v1',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('metadata','readonly'),q=t.objectStore('metadata').getAll();q.onsuccess=()=>resolve(q.result.flatMap(v=>v.operations||[]).filter(o=>o.target.node_id===${JSON.stringify(node)}));q.onerror=()=>reject(q.error);t.oncomplete=()=>db.close();};})`);
  console.log(JSON.stringify({operations}));process.exit(0);
 }
 if(action==='reload'){await command('Page.reload',{});console.log(JSON.stringify({action:'production-page-reload',acknowledged:true}));}else{
 if(action==='open'||action==='reopen')await wait("document.querySelector('#desktopWorkOpen')");
 if(action==='create')await wait("document.querySelector('.desktop-create select')?.options.length>1&&[...document.querySelectorAll('.desktop-create button')].some(b=>b.textContent.trim()==='创建'&&!b.disabled)");
 const named={new:'新建会话',read:'打开会话',pick:'图片'}[action];if(named)await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(named)}&&!b.disabled&&b.getClientRects().length)`);
 if(action==='target')await wait("document.querySelector('.desktop-target')");if(action==='work')await wait("document.querySelector('.desktop-work')");
 if(action==='clear-old-fixture-drafts')await evaluate("(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('ash.desktop.unsent-drafts.v1:'))localStorage.removeItem(key);return true;})()");
 if(action==='open')await evaluate("(()=>{const b=document.querySelector('#desktopWorkOpen');if(!b)throw Error('production computer button missing');b.click();return true;})()");
 if(action==='new')await evaluate(button('新建会话'));
 if(action==='close-create')await evaluate(button('关闭新建'));
 if(action==='create-current')await evaluate("(()=>{const f=document.querySelector('.desktop-create form');f.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:f.querySelector('button[type=submit]')}));return true;})()");
 if(action==='inspect-create')console.log(JSON.stringify(await evaluate("(()=>({inputs:[...document.querySelectorAll('.desktop-create textarea')].map(t=>({value:t.value,visible:!!t.getClientRects().length})),html:document.querySelector('.desktop-create')?.outerHTML,create_outbox:localStorage.getItem('ash.desktop.create-outbox.v1'),document_hidden:document.hidden,onsubmit:typeof document.querySelector('.desktop-create form')?.onsubmit,selected:document.querySelector('.desktop-create select')?.value}))()")));
 if(action==='create')await evaluate("(()=>{const s=document.querySelector('.desktop-create select');const options=s&&[...s.options].filter(o=>o.value);if(!options?.length)throw Error('Project not actually enumerated');s.value=options[0].value;s.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('.desktop-create textarea');if(!input)throw Error('create composer absent');input.value='Android isolated project first text';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()").then(()=>evaluate(button('创建')));
 if(action==='target')await evaluate("(()=>{const b=document.querySelector('.desktop-target');if(!b)throw Error('actual target absent');b.click();return true;})()");
 if(action==='work')await evaluate("(()=>{const b=document.querySelector('.desktop-work');if(!b)throw Error('actual saved work absent');b.click();return true;})()");
 if(action==='read')await evaluate(button('打开会话'));
 if(action==='pick')await evaluate(button('图片'));
 if(action==='remove-image'){await wait("document.querySelector('button[aria-label=\"移除图片\"]')&&!document.querySelector('button[aria-label=\"移除图片\"]').disabled");await evaluate("(()=>{document.querySelector('button[aria-label=\"移除图片\"]').click();return true;})()");}
 if(action==='send')await evaluate("(()=>{const input=document.querySelector('.desktop-control textarea');if(!input)throw Error('image composer absent');input.value='Android selected PNG and text';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()").then(()=>evaluate(button('发送')));
 if(action==='reopen'){
  await evaluate("(()=>{const b=document.querySelector('#desktopWorkOpen');if(!b)throw Error('computer button missing');b.click();return true;})()");
 }
 await wait("document.body!==null");
 const value=await evaluate("(()=>({url:location.href,ready:!!globalThis.__ashMaterialPicker,buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({text:b.textContent.trim(),disabled:b.disabled})),selects:[...document.querySelectorAll('select')].filter(s=>s.getClientRects().length).map(s=>({class:s.className,values:[...s.options].map(o=>({text:o.textContent,value:o.value}))})),messages:[...document.querySelectorAll('#desktopWork [data-message]')].map(n=>({id:n.dataset.message,text:n.innerText})),text:document.querySelector('.desktop-create:not([hidden])')?.innerText||document.querySelector('#desktopWork')?.innerText||document.body.innerText}))()");
 console.log(JSON.stringify(value));if(process.argv[3])writeFileSync(`docs/evidence/project-android-local-20261012/${process.argv[3]}.json`,JSON.stringify(value,null,2));
}}finally{ws.close();}

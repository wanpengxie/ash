import { DesktopCreateStore, createKey, createReady, createProjectsValid } from './desktop-create-store.js';
const el=(d,t,text)=>{const e=d.createElement(t);if(text!==undefined)e.textContent=text;return e;};
const labels={not_started:'尚未开始',invoking:'处理中',accepted:'已确认',rejected:'失败',unknown:'待确认'};
export function createTitle(input){
  const line=input.split(/[\r\n]/).map(s=>s.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim()).find(Boolean)||'';
  const sentence=line.match(/^[^。！？.!?]+[。！？.!?]?/)?.[0]||line;
  let title='',bytes=0;for(const character of sentence){const count=new TextEncoder().encode(character).length;if(bytes+count>256)break;title+=character;bytes+=count;}return title.trim();
}
export class DesktopCreate {
  constructor(doc,net,{store=new DesktopCreateStore({endpoint:net.endpoint}),now=Date.now,id=()=>crypto.randomUUID(),onRead=()=>{}}={}) {
    this.doc=doc;this.net=net;this.store=store;this.now=now;this.id=id;this.onRead=onRead;this.epoch=0;
    this.root=el(doc,'section');this.root.className='desktop-create';this.root.setAttribute('aria-label','新建会话');this.root.hidden=true;
    doc.addEventListener('visibilitychange',()=>{this.cancel();if(!doc.hidden && this.opened)void this.refresh();});
  }
  cancel(){this.epoch++;this.controller?.abort();this.busy=false;}
  stop(force=false){if(!force&&this.onDraftSave?.()===false)return false;this.cancel();this.opened=false;this.draftInput=null;this.form=null;this.formBinding=null;this.composing=false;this.root.hidden=true;this.input='';}
  reset(){this.stop(true);this.store.bind(this.net.currentScope);this.store.clear();this.target=null;this.projects=null;this.render();}
  network(s){if(['offline','connecting'].includes(s)){this.cancel();this.projects=null;if(this.opened){this.notice='连接已断开';this.render();}}else if(s==='online'&&this.opened)void this.refresh();}
  open(){if(this.stop()===false)return;this.opened=true;this.root.hidden=false;this.target=null;this.projects=null;this.project=null;this.targets=[];this.store.bind(this.net.currentScope);if(!this.root.isConnected)this.doc.body.append(this.root);this.render();void this.refresh();}
  async run(fn){
    if(!this.opened||this.doc.hidden||this.busy||!this.net.currentScope||!this.net.connectionId)return;
    this.cancel();const epoch=this.epoch,scope=this.net.currentScope,connectionId=this.net.connectionId,c=this.controller=new AbortController();this.busy=true;
    const current=()=>this.opened&&!this.doc.hidden&&epoch===this.epoch&&scope===this.net.currentScope&&connectionId===this.net.connectionId&&!c.signal.aborted;
    try{await fn(c.signal,current,scope);}catch(e){if(current()){this.projects=null;this.notice=e?.code==='permission_denied'?'创建权限已失效，请重新选择电脑':'暂时无法确认结果';if(e?.code==='permission_denied'){this.store.clear();this.target=null;} }}finally{if(current()){this.busy=false;this.render();}}
  }
  async discover(signal,current,scope){const d=await this.net.collaborationCreateEndpoints(signal);if(!current())return false;if(d.auth_scope!==scope){this.reset();return false;}this.targets=(d.create_targets||[]).filter(createReady);this.store.reconcile(this.targets);if(this.target){const target=this.targets.find(t=>createKey(t)===createKey(this.target));if(!target){this.cancel();this.target=null;this.projects=null;this.notice='创建范围已改变或撤销';this.render();return false;}this.target=target;}return true;}
  refresh(){return this.run(async(signal,current,scope)=>{
    if(!await this.discover(signal,current,scope))return;
    if(!this.target&&this.targets.length===1)this.target=this.targets[0];
    if(!this.target){this.notice=this.targets.length?'选择电脑和项目':'没有已授权新建会话的电脑';return;}
    const t=this.target;
    // Saved receipt recovery does not depend on a live native project listing.
    for(const item of this.store.list(t)){
      const r=await this.net.collaborationCreate('query',this.queryBody(item),signal);
      if(!current())return;
      if(r.auth_scope!==scope || !await this.discover(signal,current,scope))return;
      this.store.accept(item,r.fact);this.notice='';
    }
    const p=await this.net.collaborationCreate('projects',{version:1,device_id:t.device_id,node_id:t.endpoint_id,endpoint_id:t.endpoint_id,authorization_revision:t.authorization_revision,cwd:t.scope.cwd},signal);
    if(!current())return;
    if(p.auth_scope!==scope||!createProjectsValid(p,t))throw Error('invalid projects');
    if(!await this.discover(signal,current,scope))return;
    this.projects=p;this.project=this.store.selected(t,p.projects)||(p.projects.length===1?p.projects[0]:null);if(this.project)this.store.select(t,this.project);this.notice='';
  });}
  selectTarget(t){if(this.onDraftSave?.()===false)return;this.cancel();this.target=t;this.projects=null;this.project=null;this.title='';this.input='';this.render();void this.refresh();}
  queryBody(i){return {version:1,device_id:this.target.device_id,target:i.request.target,authorization_revision:i.request.authorization_revision,operation_id:i.request.operation_id};}
  async submit(){
    if(!this.opened||this.doc.hidden||!this.net.connectionId||this.store.scope!==this.net.currentScope||this.busy||!this.project||!this.projects||this.composing||!this.input?.trim())return;
    const title=createTitle(this.input);if(!title){this.notice='请写下要求';this.render();return;}
    const t=this.target,request={version:1,request_id:this.id(),operation_id:this.id(),authorization_revision:t.authorization_revision,target:{node_id:t.endpoint_id,endpoint_id:t.endpoint_id,project_id:this.project.project_id,cwd:this.project.cwd},title,input:{text:this.input},expires_at:this.now()+86400000};
    const body={version:1,device_id:t.device_id,request,expected_connector_epoch:this.projects.connector_epoch};
    if(new TextEncoder().encode(request.title).length>256||/[\u0000-\u001f]/.test(request.title)||new TextEncoder().encode(JSON.stringify(body)).length>65536){this.notice='标题或内容过长，请缩短';this.render();return;}
    let item;try{item=this.store.add(t,request);}catch{this.notice='本地创建记录空间不足';this.render();return;}
    let recorded=true;if(this.onDraftSubmitted){try{recorded=!!this.store.storage&&this.store.storage.getItem('ash.desktop.create-outbox.v1')===JSON.stringify(this.store.data());}catch{recorded=false;}}
    if(!recorded||this.onDraftSubmitted?.()===false){this.store.items=this.store.items.filter(i=>i!==item);this.store.save();this.notice='暂时无法保存草稿，请稍后再发送';this.render();return;}this.title='';this.input='';this.notice='创建中…';this.render();
    await this.run(async(signal,current,scope)=>{if(!await this.discover(signal,current,scope))return;const r=await this.net.collaborationCreate('apply',body,signal);if(!current())return;if(r.auth_scope!==scope || !await this.discover(signal,current,scope))return;this.store.accept(item,r.fact);this.notice='';});
  }
  recover(item,op){return this.run(async(signal,current,scope)=>{if(!await this.discover(signal,current,scope))return;const r=await this.net.collaborationCreate(op,this.queryBody(item),signal);if(current() && r.auth_scope===scope && await this.discover(signal,current,scope)){this.store.accept(item,r.fact);this.notice='';}});}
  render(){const d=this.doc,opened=new Set([...this.root.querySelectorAll('details[open]')].map(e=>e.dataset.operation));
    const binding=this.target?JSON.stringify([this.store.scope,createKey(this.target)]):null;
    if(this.formBinding!==binding){if(this.formBinding)this.input='';this.formBinding=binding;this.form=null;this.draftInput=null;this.composing=false;}
    const retained=this.form?.parentNode===this.root?this.form:null;
    for(const child of [...this.root.childNodes])if(child!==retained)child.remove();
    const append=(...children)=>{for(const child of children)this.root.insertBefore(child,retained);};
    const head=el(d,'div');head.className='desktop-header';head.append(el(d,'h2','新建会话'));const close=el(d,'button','关闭新建');close.onclick=()=>this.stop();head.append(close);append(head);
    if(this.notice)append(el(d,'p',this.notice));if(!this.target){for(const t of this.targets||[]){const b=el(d,'button',`${t.name} · 新建会话`);b.onclick=()=>this.selectTarget(t);append(b);}this.onDraftReady?.();return;}
    for(const i of this.store.list(this.target)){
      const row=el(d,'article');row.className='desktop-create-operation';row.dataset.operation=i.request.operation_id;
      const stages=['create','name','first_input'],failed=stages.some(s=>i.fact?.[s].status==='rejected'),pending=!i.fact||stages.some(s=>['invoking','unknown'].includes(i.fact[s].status));
      row.append(el(d,'p',i.submitted?.title),el(d,'small',failed?'创建未完成':pending?'创建结果待确认':i.fact.first_input.status==='accepted'?'已创建':'创建未完成'));
      const detail=el(d,'details');detail.dataset.operation=i.request.operation_id;detail.open=opened.has(i.request.operation_id);detail.append(el(d,'summary','详情'));if(i.submitted){const text=el(d,'p',i.submitted.text);text.className='desktop-text';detail.append(text);}
      for(const [stage,title]of[['create','创建'],['name','标题'],['first_input','消息']])detail.append(el(d,'p',`${title}：${i.fact?labels[i.fact[stage].status]:'待确认'}`));
      if(i.fact?.work){detail.append(el(d,'p',`会话：${i.fact.work.native_id}`));const b=el(d,'button','打开会话');b.onclick=()=>void this.onRead(i.fact.work);row.append(b);}
      for(const [op,label]of[['query','查询结果'],['reconcile','核查结果']]){const b=el(d,'button',label);b.disabled=this.busy;b.onclick=()=>void this.recover(i,op);detail.append(b);}row.append(detail);append(row);
    }
    const shortProject=this.project?.cwd.split(/[\\/]/).filter(Boolean).at(-1)||this.project?.cwd;append(el(d,'p',[this.target.name,shortProject].filter(Boolean).join(' · ')));
    if(!this.form){
      const form=this.form=el(d,'form'),select=this.projectSelect=el(d,'select');select.setAttribute('aria-label','项目');
      select.onchange=()=>{if(this.onDraftSave?.()===false){select.value=this.project?.project_id||'';return;}const next=this.projects.projects.find(p=>p.project_id===select.value)||null;if(next?.project_id!==this.project?.project_id){this.input='';this.composing=false;}this.project=next;if(this.project)this.store.select(this.target,this.project);this.render();};
      const input=this.draftInput=el(d,'textarea');input.setAttribute('aria-label','内容');input.placeholder='想让它做什么？';
      input.oninput=()=>{if(this.draftInput===input){this.input=input.value;this.onDraftSave?.(true);}};
      input.addEventListener('compositionstart',()=>{if(this.draftInput===input)this.composing=true;});
      input.addEventListener('compositionend',()=>{if(this.draftInput===input){this.composing=false;this.input=input.value;this.onDraftSave?.(true);this.onDraftReady?.();}});
      input.addEventListener('blur',()=>{if(this.draftInput===input){this.composing=false;this.input=input.value;this.onDraftSave?.(true);this.onDraftReady?.();}});
      this.sendButton=el(d,'button','创建');this.sendButton.type='submit';this.sendButton.addEventListener('pointerdown',()=>{if(this.composing)input.blur();});form.onsubmit=e=>{e.preventDefault();void this.submit();};form.append(select,input,this.sendButton);append(form);
    }
    const select=this.projectSelect,projects=this.projects?.projects||[],short=p=>p.cwd.split(/[\\/]/).filter(Boolean).at(-1)||p.cwd;
    select.replaceChildren(new Option('请选择项目',''));for(const p of projects)select.append(new Option(projects.filter(q=>short(q)===short(p)).length>1?p.cwd:short(p),p.project_id));
    select.value=this.project?.project_id||'';select.disabled=this.busy||!this.projects;select.hidden=projects.length===1;
    if(!this.composing&&this.draftInput.value!==(this.input||''))this.draftInput.value=this.input||'';
    this.draftInput.disabled=!this.project;this.sendButton.disabled=this.busy||!this.project||!this.projects;
    const refresh=el(d,'button','重试');refresh.disabled=this.busy;refresh.onclick=()=>void this.refresh();refresh.hidden=!!this.projects;append(refresh);this.onDraftReady?.();
  }
}

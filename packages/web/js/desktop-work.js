import { appendMarkdown } from './markdown.js';
import { DesktopSharedDrafts } from './desktop-shared-drafts.js';
import { DesktopCreate } from './desktop-create.js';
import { DesktopControl, controlKey } from './desktop-control.js';
import { DesktopWorkStore, targetKey, validTarget, workKey } from './desktop-work-store.js';

const node = (doc, tag, text, className) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
export class DesktopWork {
  constructor(root, net, { store = new DesktopWorkStore({ endpoint: net.endpoint }), pollMs = 4000, control, onMaterials, imagePortFactory } = {}) {
    this.onMaterials = onMaterials; this.root = root; this.doc = root.ownerDocument; this.control = control || new DesktopControl(this.doc, net); this.net = net; this.store = store; this.pollMs = pollMs;
    this.control.imagePortFactory=imagePortFactory;
    this.sharedDrafts = new DesktopSharedDrafts({ endpoint: net.endpoint, requireStorage: true });
    this.control.onDraftSave = editing => this.saveSharedDraft('control',editing);
    this.control.onDraftReady = () => this.applySharedDraft('control');
    this.control.onDraftSubmitted = () => this.forgetSharedDraft('control');
    this.resultEpoch=0; this.resultCursors=new Map(); this.epoch = 0; this.opened = false; this.target = null; this.work = null; this.entry = null; this.newMessages = false; this.delay = pollMs;
    this.doc.addEventListener('visibilitychange', () => { this.cancel(); if (!this.doc.hidden && this.opened) void this.refresh(); });
    globalThis.addEventListener?.('pagehide', () => this.close());
  }
  async saveResultFile(turn, message, href, body) {
    if(this.resultSaving)return;
    const captured={epoch:this.resultEpoch,target:this.target,work:this.work,scope:this.net.currentScope,connectionId:this.net.connectionId};
    const current=()=>this.opened&&this.resultEpoch===captured.epoch&&this.target===captured.target&&this.work===captured.work&&this.net.currentScope===captured.scope&&this.net.connectionId===captured.connectionId;
    let notice=body.parentNode.querySelector('.desktop-result-save-status');if(!notice){notice=node(this.doc,'p','', 'desktop-result-save-status');notice.setAttribute('role','status');body.after(notice);}
    if(typeof this.net.saveCoworkerResult!=='function'){notice.textContent='此设备暂时无法保存结果文件';return;}
    this.resultSaving=true;notice.textContent='正在确认结果文件…';
    try {
      const result=await this.net.collaborationResultFile(captured.target,captured.work,turn.turn_id,message.source_message_id,href,this.resultCursors.get(JSON.stringify([workKey(captured.work),turn.turn_id,message.source_message_id])));
      if(!current())return;
      if(result.state==='approval_required'){notice.textContent=`请在电脑确认「${result.display_name}」，再点击此文件领取`;return;}
      if(result.state!=='ready'||!result.save_id||!result.asset)throw new Error('invalid');
      notice.textContent='正在准备保存…';
      const saved=await this.net.saveCoworkerResult(result);
      if(current())notice.textContent=saved.cancelled?'已取消保存':saved.ok?'已保存到所选位置':'领取已过期或授权已改变，请在电脑重新确认';
    } catch(error) {if(current())notice.textContent=['expired','not_found','permission_denied'].includes(error?.code)?'领取已过期或授权已改变，请在电脑重新确认':'暂时无法领取，请重试';}
    finally{this.resultSaving=false;if(this.opened&&!this.doc.hidden){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.refresh(),this.delay);}}
  }
  restoreSharedDrafts() {
    if (!this.net.currentScope || !this.net.connectionId) return false;
    this.sharedDrafts.bind(this.net.currentScope);
    if (!this.sharedDrafts.pending || this.opened || this.create?.opened || this.restoredShareScope === this.net.currentScope) return false;
    this.restoredShareScope = this.net.currentScope; this.open(); return true;
  }
  receiveShare(share) {
    if (!this.net.currentScope || !this.net.connectionId) return false;
    this.sharedDrafts.bind(this.net.currentScope);
    if (this.sharedDrafts.seen.has(share?.id)) return true;
    if (!this.saveSharedDraft('control') || !this.saveSharedDraft('create') || !this.sharedDrafts.stage(share)) { this.showShareNotice('暂时无法接收，请先处理已有草稿'); return false; }
    this.showShareNotice('');
    this.create?.stop(); this.open(); return true;
  }
  showShareNotice(text) {
    const pane=this.create?.opened?this.create.root:this.root;
    if(text&&this.shareNotice===text&&this.shareNoticeElement?.parentNode===pane)return;
    this.shareNotice = text;
    this.shareNoticeElement?.remove();
    this.shareNoticeElement = null;
    if (!text) return;
    const notice=node(this.doc,'div',undefined,'desktop-share-notice');notice.setAttribute('role','status');
    const retry=node(this.doc,'button','重试接收');retry.type='button';retry.onclick=()=>globalThis.__ashShareText?.flush?.();
    notice.append(node(this.doc,'p',text),retry);this.shareNoticeElement=notice;
    const head=pane.querySelector('.desktop-header');if(head)head.after(notice);else pane.append(notice);
  }
  saveSharedDraft(kind, editing=false) {
    this.sharedDrafts.bind(this.net.currentScope);
    const c=kind==='control'?this.control:this.create;if(!c?.draftInput)return true;
    const key=kind==='control'?c.scope===this.net.currentScope&&c.target&&c.work?JSON.stringify([c.scope,controlKey(c.target),workKey(c.work)]):null:c.store.scope===this.net.currentScope&&c.formBinding&&c.project?JSON.stringify([c.formBinding,c.project.project_id,c.project.cwd]):null;
    const saved=this.sharedDrafts.remember(kind,key,c.draftInput?.value ?? (kind==='control'?c.draft:c.input) ?? '');
    c.draftSaveFailed=!saved;
    if(saved){c.draftSaveError?.remove();c.draftSaveError=null;}else if(editing){if(!c.draftSaveError){c.draftSaveError=node(this.doc,'p','暂时无法保存草稿，请保留当前页面');c.draftSaveError.setAttribute('role','status');c.form?.append(c.draftSaveError);}}else if(c.notice!=='暂时无法保存草稿，请保留当前页面'){c.notice='暂时无法保存草稿，请保留当前页面';c.render();}return saved;
  }
  forgetSharedDraft(kind) {
    const c=kind==='control'?this.control:this.create;
    const key=kind==='control'?JSON.stringify([c.scope,controlKey(c.target),workKey(c.work)]):JSON.stringify([c.formBinding,c.project.project_id,c.project.cwd]);
    return this.sharedDrafts.forget(kind,key);
  }
  applySharedDraft(kind) {
    this.sharedDrafts.bind(this.net.currentScope);const c=kind==='control'?this.control:this.create;
    if(!this.net.currentScope||!c?.draftInput||c.composing||c.draftSaveFailed)return;
    if(kind==='control'&&(!c.target||c.scope!==this.net.currentScope||!this.work))return;
    if(kind==='create'&&(!c.target||!c.project||!c.projects||this.create.store.scope!==this.net.currentScope))return;
    const key=kind==='control'?JSON.stringify([c.scope,controlKey(c.target),workKey(c.work)]):JSON.stringify([c.formBinding,c.project.project_id,c.project.cwd]);
    if(this.sharedDrafts.pending&&this.sharedDrafts.fullFor(kind,key)){const notice='请先处理已有草稿，再选择其他会话';if(c.notice!==notice){c.notice=notice;c.render();}return;}
    const text=this.sharedDrafts.take(kind,key,kind==='control'?c.draft:c.input||'');if(text===null){if(this.sharedDrafts.takeError==='too_large')this.showShareNotice('草稿过长，请先缩短内容再接收');if(this.sharedDrafts.takeError==='storage_failure')this.showShareNotice('暂时无法保存草稿，请保留当前页面');return;}
    if(kind==='control')c.draft=text;else c.input=text;c.render();
  }
  openCreate(){if(this.saveSharedDraft('control'))this.getCreate().open();}
  getCreate() { if (!this.create) { this.create = new DesktopCreate(this.doc, this.net, { onRead: async work => { try { const scope = this.net.currentScope, connectionId = this.net.connectionId, createEpoch = this.create.epoch; const result = await this.net.collaborationEndpoints(); if (!this.opened || !this.create.opened || createEpoch !== this.create.epoch || scope !== this.net.currentScope || connectionId !== this.net.connectionId || result.auth_scope !== scope) return; const target = result.targets.find(t => validTarget(t) && t.node_id === work.node_id && t.endpoint_id === work.endpoint_id); if (!target) { this.create.notice = '已创建会话 · 当前没有历史读取授权'; this.create.render(); return; } this.create.stop(); this.target = target; this.selectWork({ work, title: '已创建会话' }); } catch { this.create.notice = '已创建会话 · 暂时无法确认读取授权'; this.create.render(); } } }); this.create.onDraftSave=editing=>this.saveSharedDraft('create',editing); this.create.onDraftReady=()=>{this.applySharedDraft('create');if(this.shareNotice)this.showShareNotice(this.shareNotice);}; this.create.onDraftSubmitted=()=>this.forgetSharedDraft('create'); } return this.create; }
  cancel() { this.epoch++; this.controller?.abort(); clearTimeout(this.timer); this.loading = false; }
  network(status) {
    this.control.network(status); this.create?.network(status);
    if (status === 'offline' || status === 'connecting') {
      this.cancel();
      if (this.opened) this.render(this.entry ? '离线 · 显示缓存' : '离线 · 无缓存');
    } else if (status === 'online' && this.opened && !this.doc.hidden) void this.refresh();
  }
  reset() { this.resultEpoch++; this.resultCursors.clear(); this.create?.reset(); this.control.reset(); this.cancel(); this.store.bind(this.net.currentScope); this.store.invalidate(); this.controlTargets = []; this.targets = []; this.target = null; this.work = null; this.entry = null; this.sharedDrafts.bind(this.net.currentScope); this.sharedDrafts.clear(); this.showShareNotice(''); if (this.opened) { this.render('身份或读取范围已改变，请重新选择电脑'); } }
  close() { if(this.create?.stop()===false||this.control.stop()===false)return; this.resultEpoch++; this.cancel(); this.opened = false; this.root.hidden = true; }
  open() {
    if(this.control.stop()===false)return; this.resultEpoch++; this.cancel(); this.opened = true; this.root.hidden = false; this.store.bind(this.net.currentScope);
    this.targets = this.store.targets; this.target = null; this.work = null; this.entry = null; this.render('读取中'); void this.refresh();
  }
  selectTarget(target) {
    if(this.control.stop()===false)return; this.resultEpoch++; this.cancel(); this.target = target; this.work = null; this.newMessages = false; this.delay = this.pollMs;
    this.entry = this.store.get(target); this.render(this.entry ? '缓存 · 正在刷新' : '读取中'); void this.refresh();
  }
  selectWork(summary) {
    if(this.control.stop()===false)return; this.resultEpoch++; this.cancel(); this.work = summary.work; this.summary = summary; this.newMessages = false; this.delay = this.pollMs;
    this.entry = this.store.get(this.target, this.work); this.render(this.entry ? '缓存 · 正在刷新' : '读取中'); void this.refresh();
  }
  async refresh(older = false) {
    if (!this.opened || this.doc.hidden || this.loading || this.resultSaving) return;
    this.cancel(); const epoch = this.epoch, scope = this.net.currentScope, connectionId = this.net.connectionId;
    this.store.bind(scope);
    if (!scope || !connectionId) { if (!scope) this.entry = null; this.render(scope && this.entry ? '离线 · 显示缓存' : scope ? '离线 · 无缓存' : '无法确认身份，暂时无法读取'); return; }
    const controller = this.controller = new AbortController(); this.loading = true;
    const current = () => this.opened && !this.doc.hidden && epoch === this.epoch && scope === this.net.currentScope && connectionId === this.net.connectionId && !controller.signal.aborted;
    let denied = false;
    try {
      const discovery = await this.net.collaborationEndpoints(controller.signal);
      if (!current()) return;
      if (discovery.auth_scope !== scope) { this.net.acceptScope(discovery.auth_scope, true); this.reset(); return; }
      this.targets = discovery.targets.filter(validTarget);
      if (!this.target) { this.store.reconcile(this.targets); this.render(this.targets.length ? '' : '暂时没有可读取的电脑'); return; }
      let target = this.targets.find(t => targetKey(t) === targetKey(this.target));
      if (!target && this.targets.some(t => t.device_id === this.target.device_id && t.node_id === this.target.node_id && t.endpoint_id === this.target.endpoint_id)) { this.store.reconcile(this.targets); this.control.reset(); this.controlTargets = []; this.cancel(); this.target = null; this.work = null; this.entry = null; this.render('读取范围已改变或已撤销，请重新选择电脑'); return; }
      // A disconnected computer can disappear from discovery. The protected
      // read below checks the original revision and distinguishes offline from
      // a revoked grant before any cache is discarded.
      target ??= this.target;
      const cursor = older ? this.entry?.gap_cursor || this.entry?.older_cursor : null;
      if (older && !cursor) return;
      const result = await this.net.collaborationRead(target, this.work, cursor, controller.signal);
      if (!current()) return;
      if (result.auth_scope !== scope) { this.net.acceptScope(result.auth_scope, true); this.reset(); return; }
      if (!result.target || ['device_id', 'node_id', 'endpoint_id', 'authorization_generation', 'authorization_revision'].some(key => result.target[key] !== target[key])) throw Object.assign(new Error('读取范围已改变'), { code: 'permission_denied' });
      this.store.reconcile(this.targets.some(t => targetKey(t) === targetKey(target)) ? this.targets : [...this.targets, target]);
      if(this.work) for(const turn of result.page.items)for(const message of turn.messages)this.resultCursors.set(JSON.stringify([workKey(this.work),turn.turn_id,message.source_message_id]),cursor);
      const oldIDs = new Set((this.entry?.page.items || []).flatMap(turn => (turn.messages || []).map(message => JSON.stringify([turn.turn_id, message.source_message_id]))));
      // The fixed desktop adapter reads turns descending; render/cache oldest to newest.
      this.entry = this.store.put(target, this.work, this.work ? { ...result.page, items: [...result.page.items].reverse() } : result.page, { older });
      const hasNew = this.work && !older && oldIDs.size > 0 && this.entry.page.items.some(turn => turn.messages.some(message => !oldIDs.has(JSON.stringify([turn.turn_id, message.source_message_id]))));
      this.render('已同步', { older, newMessages: hasNew }); this.delay = this.pollMs;
      if (this.work) {
        try {
          const controls = await this.net.collaborationControlEndpoints(controller.signal);
          if (!current()) return;
          if (controls.auth_scope !== scope) { this.net.acceptScope(controls.auth_scope, true); this.reset(); return; }
          this.controlTargets = Array.isArray(controls.control_targets) ? controls.control_targets : [];
          this.control.update(this.controlTargets, target, this.work, this.entry.page.items.flatMap(turn => turn.messages));
        } catch (error) { if (current()) { if (error?.code === 'permission_denied') { this.controlTargets = []; this.control.update([], target, this.work); } else this.control.network('offline'); } }
      }
    } catch (error) {
      if (!current()) return;
      denied = error?.code === 'permission_denied' || error?.code === 'not_found';
      if (denied) { this.control.reset(); this.store.invalidate(); this.entry = null; this.render('读取权限已失效或会话不可用'); }
      else if (error?.code === 'too_large') this.render(this.entry ? '历史页内容过大，暂时无法读取 · 显示缓存' : '历史页内容过大，暂时无法读取');
      else this.render(this.entry ? '离线或暂时无法读取 · 显示缓存' : '离线或暂时无法读取 · 无缓存');
      this.delay = Math.min(this.delay * 2, 60000);
    } finally {
      if (epoch === this.epoch) { this.loading = false; if (this.work && !denied && this.opened && !this.doc.hidden) this.timer = setTimeout(() => void this.refresh(), this.delay); }
    }
  }
  render(status, { older = false, newMessages = false } = {}) {
    const historyBinding = this.work && JSON.stringify([this.net.currentScope, this.net.connectionId, targetKey(this.target), workKey(this.work)]);
    const previous = this.root.querySelector('.desktop-messages');
    const history = previous?.historyBinding === historyBinding ? previous : null;
    const anchor = previous && [...previous.querySelectorAll('[data-message]')].find(el => el.offsetTop + el.offsetHeight >= previous.scrollTop);
    const anchorId = anchor?.dataset.message, anchorOffset = anchor ? anchor.offsetTop - previous.scrollTop : 0, scrollTop = previous?.scrollTop || 0;
    const d = this.doc; let restoreScroll;
    const menuOpen = this.root.querySelector('.desktop-menu')?.open || false;
    this.root.classList.toggle('desktop-chat', !!this.work);
    // Keep the connected composer and history in place while updating status.
    // Detaching an ancestor also ends mobile keyboard focus and IME composition.
    const composer = this.work && this.control.root.parentNode === this.root ? this.control.root : null;
    for (const child of [...this.root.childNodes]) if (child !== composer && child !== history) child.remove();
    const append = (...children) => { for (const child of children) this.root.insertBefore(child, history || composer); };
    const head = node(d, 'div', undefined, 'desktop-header');
    const backLabel = this.work ? '会话列表' : this.target ? '电脑列表' : '关闭';
    const back = node(d, 'button', this.work ? '‹' : backLabel); back.type = 'button'; back.setAttribute('aria-label', backLabel);
    back.onclick = () => { if (this.work) this.selectTarget(this.target); else if (this.target) this.open(); else this.close(); };
    head.append(back, node(d, 'h2', this.work ? this.summary?.title || '桌面会话' : this.target ? `${this.target.name} · Codex` : '已连接电脑'));
    if (this.work) {
      const menu = node(d, 'details', undefined, 'desktop-menu'); menu.open = menuOpen;
      const toggle = node(d, 'summary', '⋯'); toggle.setAttribute('aria-label', '更多'); menu.append(toggle);
      const actions = node(d, 'div', undefined, 'desktop-menu-actions');
      const addAction = (label, action) => { const button = node(d, 'button', label); button.type = 'button'; button.onclick = () => { menu.open = false; action(); }; actions.append(button); };
      addAction('刷新', () => void this.refresh());
      if (this.control.items().length) addAction('发送记录', () => this.control.showHistory());
      addAction('新建会话', () => this.openCreate());
      addAction('关闭', () => this.close());
      menu.append(actions); head.append(menu);
    } else {
      if (this.target) { const close = node(d, 'button', '关闭'); close.onclick = () => this.close(); head.append(close); }
    }
    append(head);
    if(this.shareNotice){this.showShareNotice(this.shareNotice);}
    if (!this.work) { const create = node(d, 'button', '新建会话'); create.onclick = () => this.openCreate(); append(create); }
    const normal = ['已同步', '读取中', '缓存 · 正在刷新'].includes(status);
    if (!this.work || !normal || !this.entry) {
      const label = normal ? (this.entry ? '' : '正在加载…') : status.replace(' · 显示缓存', '，显示已保存消息').replace(' · 无缓存', '').replace('离线或暂时无法读取', '暂时无法连接电脑');
      if (label) append(node(d, 'p', label, 'desktop-status'));
    }
    if (!this.target) {
      for (const target of this.targets || []) { const button = node(d, 'button', `${target.name} · Codex`, 'desktop-target'); button.onclick = () => this.selectTarget(target); append(button); }
    } else if (!this.work) {
      const rows = this.entry?.page.items || [], groups = new Map();
      for (const row of rows) { if (!groups.has(row.cwd)) groups.set(row.cwd, []); groups.get(row.cwd).push(row); }
      const directoryName = cwd => cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '会话';
      const names = [...groups.keys()].map(directoryName);
      for (const [cwd, rows] of groups) {
        const name = directoryName(cwd), heading = node(d, 'h3', names.filter(n => n === name).length > 1 ? cwd : name);
        heading.title = cwd || ''; append(heading);
        for (const row of rows) { const button = node(d, 'button', undefined, 'desktop-work'); button.append(node(d, 'strong', row.title || '未命名会话')); if (row.updated_at !== null) button.append(node(d, 'small', new Date(row.updated_at).toLocaleString())); button.onclick = () => this.selectWork(row); append(button); }
      }
      if (this.entry?.gap_cursor || this.entry?.older_cursor) { const more = node(d, 'button', '加载更多会话'); more.onclick = () => void this.refresh(true); append(more); }
    } else {
      const messages = history || node(d, 'div', undefined, 'desktop-messages'); messages.historyBinding = historyBinding; messages.tabIndex = 0; messages.setAttribute('aria-label', '桌面会话消息');
      const existing = new Map([...messages.querySelectorAll('[data-message]')].map(row => [row.dataset.message, row]));
      const rows = [];
      if (this.entry?.gap_cursor || this.entry?.older_cursor) { const more = messages.querySelector(':scope > button') || node(d, 'button', '加载更早消息'); more.onclick = () => void this.refresh(true); rows.push(more); }
      for (const turn of this.entry?.page.items || []) for (const message of turn.messages) {
        const identity = JSON.stringify([turn.turn_id, message.source_message_id]);
        const content = JSON.stringify([message.role, message.text, message.material_refs || []]);
        const saved = existing.get(identity);
        if (saved?.messageContent === content) { rows.push(saved); continue; }
        const row = node(d, 'article', undefined, `desktop-message ${message.role === 'user' ? 'desktop-user' : 'desktop-assistant'}`); row.dataset.message = identity; row.messageContent = content;
        row.setAttribute('aria-label', message.role === 'user' ? '你的消息' : '助手回复');
        const body = node(d, 'div', undefined, 'desktop-text');
        if (message.role === 'user') body.textContent = message.text;
        else appendMarkdown(body, message.text, { onFileLink: href => void this.saveResultFile(turn, message, href, body) });
        row.append(body);
        for (const ref of message.material_refs || []) row.append(node(d, 'p', `${({ image: '图片', video: '视频', audio: '音频' })[ref.kind] || '附件'}（未同步）`, 'desktop-material'));
        rows.push(row);
      }
      // Preserve unchanged reply nodes (including a long-press selection or code copy)
      // and the connected history ancestor during background refresh.
      const retained = new Set(rows);
      for (const child of [...messages.childNodes]) if (!retained.has(child)) child.remove();
      let next = messages.firstChild;
      for (const row of rows) { if (row !== next) messages.insertBefore(row, next); next = row.nextSibling; }
      if (!history) {
        messages.addEventListener('scroll', () => { if (messages.scrollTop < 40 && (this.entry?.gap_cursor || this.entry?.older_cursor)) void this.refresh(true); });
        this.root.insertBefore(messages, composer);
      }
      restoreScroll = () => { if (anchorId) { const restored = [...messages.querySelectorAll('[data-message]')].find(el => el.dataset.message === anchorId); messages.scrollTop = restored ? restored.offsetTop - anchorOffset : scrollTop; }
      else if (!previous?.querySelector('[data-message]') && this.entry) messages.scrollTop = messages.scrollHeight; };
      if (newMessages || this.newMessages) { this.newMessages = true; const notice = node(d, 'button', '↓ 新消息', 'desktop-new'); notice.onclick = () => { messages.scrollTop = messages.scrollHeight; this.newMessages = false; notice.remove(); }; this.root.insertBefore(notice, composer); }
    }
    if (!this.work) { const refresh = node(d, 'button', '刷新'); refresh.onclick = () => void this.refresh(); append(refresh); }
    if (this.work) {
      const controlRoot = this.control.update(this.controlTargets || [], this.target, this.work, (this.entry?.page.items || []).flatMap(turn => turn.messages));
      if (controlRoot.parentNode !== this.root) this.root.append(controlRoot);
    }
    restoreScroll?.();
  }
}

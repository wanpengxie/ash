import { DesktopImageComposer } from './desktop-image-composer.js';
import { workKey } from './desktop-work-store.js';

const OUTBOX_KEY = 'ash.desktop.control-outbox.v1';
const TTL = 24 * 60 * 60 * 1000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const sameWork = (a, b) => !!a && !!b && workKey(a) === workKey(b);
const staleNotice = '会话状态已变化，原文已保留，请重新发送。';
const statusText = { local: '准备发送', recorded: '等待发送', invoking: '发送中', accepted: '已发送', unknown: '发送结果待确认', rejected: '未发送' };
const element = (doc, tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const storageDefault = () => { try { return globalThis.localStorage; } catch { return null; } };

const idValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const identityValid = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const keysOnly = (object, allowed) => !!object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => allowed.includes(key));
const workValid = work => keysOnly(work, ['node_id', 'endpoint_id', 'kind', 'native_id']) && work.kind === 'conversation' && ['node_id', 'endpoint_id'].every(key => identityValid(work[key])) && idValid(work.native_id);
function factValid(f, request) {
  if (!keysOnly(f, ['request_id', 'operation_id', 'work', 'action', 'expires_at', 'delivery_status', 'attempt_id', 'connector_epoch', 'native_client_message_id', 'native_interface_version', 'expected_turn_id', 'receipt', 'reconciliation', 'error_code', 'observed_at']) || !workValid(f.work) || !sameWork(f.work, request.work) || f.request_id !== request.request_id || f.operation_id !== request.operation_id || f.action !== request.action || f.expires_at !== request.expires_at || f.expected_turn_id !== (request.expected_turn_id ?? null) || !['recorded', 'invoking', 'accepted', 'rejected', 'unknown'].includes(f.delivery_status) || !Number.isSafeInteger(f.observed_at) || f.observed_at < 0) return false;
  for (const key of ['attempt_id', 'connector_epoch', 'native_client_message_id', 'native_interface_version', 'expected_turn_id']) if (f[key] !== null && !idValid(f[key])) return false;
  if (f.error_code !== null && !['invalid', 'too_large', 'permission_denied', 'expired', 'conflict', 'busy', 'storage_failure', 'unsupported', 'offline', 'stale_precondition', 'result_unknown'].includes(f.error_code)) return false;
  if (f.delivery_status === 'accepted' && f.receipt === null) return false;
  const r = f.receipt;
  if (r !== null && (!keysOnly(r, ['accepted_by', 'native_turn_id', 'native_message_id', 'correlation']) || !['native', 'connector'].includes(r.accepted_by) || !['uncertain', 'stable_message_id'].includes(r.correlation) || f.delivery_status !== 'accepted' || ['native_turn_id', 'native_message_id'].some(key => r[key] !== undefined && !idValid(r[key])) || (r.correlation === 'stable_message_id' && (r.accepted_by !== 'native' || !r.native_turn_id || !r.native_message_id)))) return false;
  const p = f.reconciliation;
  if (p !== null && (!keysOnly(p, ['source', 'lookup_scope', 'pages_observed', 'history_exhausted', 'native_interface_version', 'connector_epoch', 'observed_at', 'native_client_message_id', 'native_turn_id', 'native_message_id']) || p.source !== 'codex.saved_history' || p.lookup_scope !== 'bounded_history_pages' || !Number.isSafeInteger(p.pages_observed) || p.pages_observed < 1 || p.pages_observed > 4 || typeof p.history_exhausted !== 'boolean' || typeof p.observed_at !== 'string' || !Number.isFinite(Date.parse(p.observed_at)) || ['native_interface_version', 'connector_epoch', 'native_client_message_id', 'native_turn_id', 'native_message_id'].some(key => !idValid(p[key])) || !r || r.correlation !== 'stable_message_id' || p.native_client_message_id !== f.native_client_message_id || p.native_turn_id !== r.native_turn_id || p.native_message_id !== r.native_message_id || p.native_interface_version !== f.native_interface_version)) return false;
  return true;
}

// This is a bounded local submission outbox, never a second execution ledger.
export class ControlOutbox {
  constructor({ storage = storageDefault(), endpoint = globalThis.location?.origin || 'local', now = Date.now } = {}) {
    this.storage = storage; this.endpoint = endpoint; this.now = now; this.scope = null; this.items = []; this.persistent = !!storage;
  }
  bind(scope) {
    if (this.scope === scope) return;
    this.scope = scope; this.items = [];
    try { const saved = JSON.parse(this.storage?.getItem(OUTBOX_KEY) || 'null'); if (scope && saved?.scope === scope && saved.endpoint === this.endpoint && Array.isArray(saved.items)) this.items = saved.items.filter(item => this.valid(item)).map(item => ({ ...item, status: 'unknown', fact: null })); } catch { /* unavailable storage does not grant permission */ }
    this.save();
  }
  valid(item) { return !!item && typeof item.key === 'string' && Number.isFinite(item.created) && item.created <= this.now() && item.created + TTL > this.now() && item.request && idValid(item.request.operation_id) && idValid(item.request.request_id) && typeof item.request.input?.text === 'string' && item.request.input.text.length > 0 && workValid(item.request.work) && ['send_input', 'steer'].includes(item.request.action) && Number.isSafeInteger(item.request.expires_at) && item.request.expires_at > 0 && (item.request.action !== 'steer' || idValid(item.request.expected_turn_id)) && Object.hasOwn(statusText, item.status) && (!item.fact || (factValid(item.fact, item.request) && item.status === item.fact.delivery_status)); }
  save() {
    this.items = this.items.filter(item => this.valid(item)).slice(-32);
    while (this.items.length && bytes(this.items) > 256 * 1024) this.items.shift();
    try { if (this.scope) this.storage?.setItem(OUTBOX_KEY, JSON.stringify({ scope: this.scope, endpoint: this.endpoint, items: this.items })); else this.storage?.removeItem(OUTBOX_KEY); } catch { this.persistent = false; }
  }
  savedReliably() { try { return !!this.storage && this.storage.getItem(OUTBOX_KEY) === JSON.stringify({ scope: this.scope, endpoint: this.endpoint, items: this.items }); } catch { return false; } }
  clear() { this.items = []; this.save(); }
  reconcile(targets) { const allowed = new Set(targets.filter(controlReady).map(controlKey)); this.items = this.items.filter(item => allowed.has(item.key)); this.save(); }
  list(target, work) { this.save(); return this.items.filter(item => item.key === controlKey(target) && sameWork(item.request.work, work)); }
  add(item) { this.items.push(item); this.save(); if (!this.items.includes(item)) throw new Error('outbox capacity exceeded'); }
}
export const controlKey = target => JSON.stringify([target?.device_id, target?.endpoint_id, target?.authorization_revision]);
export function controlReady(t) { return !!t && t.version === 1 && t.device_id === `device:${t.endpoint_id}` && t.grant_state === 'ready' && /^[a-f0-9]{64}$/.test(t.authorization_revision) && Array.isArray(t.actions) && t.actions.every(a => ['send_input', 'steer'].includes(a)) && ['state', 'apply', 'query', 'reconcile'].every(op => t.capabilities?.includes(op)); }
export function mappedMessage(item, message) {
  const fact = item.fact;
  if (!fact || fact.delivery_status !== 'accepted' || message.role !== 'user' || !sameWork(item.request.work, message.work)) return false;
  const receipt = fact.receipt;
  if (receipt?.accepted_by !== 'native') return false;
  return !!((fact.native_client_message_id && message.source_client_message_id === fact.native_client_message_id) ||
    (receipt?.correlation === 'stable_message_id' && receipt.native_message_id === message.source_message_id && receipt.native_turn_id === message.turn_id));
}

export class DesktopControl {
  constructor(doc, net, { outbox = new ControlOutbox({ endpoint: net.endpoint }), pollMs = 4000, now = Date.now, id = () => globalThis.crypto.randomUUID() } = {}) {
    this.doc = doc; this.net = net; this.outbox = outbox; this.pollMs = pollMs; this.now = now; this.id = id; this.epoch = 0; this.visible = false; this.draft = ''; this.root = element(doc, 'section', undefined, 'desktop-control'); this.root.setAttribute('aria-label', '向桌面会话发送');
    doc.addEventListener('visibilitychange', () => { this.cancel(); if (!doc.hidden && this.visible) void this.refresh(); });
  }
  cancel() { this.epoch++; this.controller?.abort(); clearTimeout(this.timer); this.busy = false; }
  stop(force = false) { if(!force && this.onDraftSave?.()===false)return false; this.cancel(); this.visible = false; this.state = null; this.draft = ''; this.image?.close();this.image=null; this.clearComposer(); }
  clearComposer() { this.historyShown = false; this.composing = false; this.draftInput = null; this.root?.replaceChildren(); this.form = null; }
  reset() { this.stop(true); this.outbox.bind(this.net.currentScope); this.outbox.clear(); this.target = null; this.work = null; this.render(); }
  network(status) { this.offline = status === 'offline' || status === 'connecting'; if (this.offline) { this.cancel(); this.state = null; this.render(); } else if (this.visible && !this.doc.hidden) void this.refresh(); }
  update(targets, readTarget, work, messages = []) {
    this.outbox.bind(this.net.currentScope); this.outbox.reconcile(targets);
    const target = targets.find(t => t.device_id === readTarget?.device_id && t.endpoint_id === work?.endpoint_id && controlReady(t));
    const changed = !this.visible || controlKey(target) !== controlKey(this.target) || !sameWork(work, this.work) || this.scope !== this.net.currentScope;
    if (changed) { this.onDraftSave?.(); this.cancel(); this.state = null; this.draft = ''; this.notice = ''; this.clearComposer(); }
    this.scope = this.net.currentScope; this.target = target; this.work = work; this.messages = messages; this.visible = !!work;
    if(changed){this.image?.close();this.image=null;if(this.imagePortFactory&&target&&work){const binding=JSON.stringify([this.scope,controlKey(target),workKey(work)]);this.image=new DesktopImageComposer({port:this.imagePortFactory(),work,canSend:()=>!this.doc.hidden,isCurrent:()=>this.visible&&JSON.stringify([this.net.currentScope,controlKey(this.target),this.work&&workKey(this.work)])===binding,onChange:()=>this.render(),onAccepted:text=>{if(this.draft===text){if(this.onDraftSubmitted?.()===false)return false;this.draft='';}else if(this.onDraftSave?.()===false)return false;this.render();return true;}});}}

    this.render(); if (changed && target && work && !this.doc.hidden) void this.refresh();
    return this.root;
  }
  base() { return { version: 1, device_id: this.target.device_id, endpoint_id: this.target.endpoint_id, authorization_revision: this.target.authorization_revision, work: this.work }; }
  action() {
    if (!this.state || this.state.authorization_revision !== this.target?.authorization_revision) return null;
    const s = this.state.snapshot;
    if (this.stateAction === 'steer' && s.state === 'active' && s.turn_id && s.identity_provenance !== 'none' && this.state.allowed_actions.includes('steer')) return 'steer';
    if (this.stateAction === 'send_input' && s.state === 'idle' && this.state.allowed_actions.includes('send_input')) return 'send_input';
    return null;
  }
  current(epoch, scope, connectionId, controller) { return this.visible && !this.doc.hidden && this.epoch === epoch && this.net.currentScope === scope && this.net.connectionId === connectionId && !controller.signal.aborted; }
  async run(fn) {
    if (!this.visible || !this.target || this.doc.hidden || this.busy || !this.net.currentScope || !this.net.connectionId) return;
    this.cancel(); const epoch = this.epoch, scope = this.net.currentScope, connectionId = this.net.connectionId, controller = this.controller = new AbortController(); this.busy = true; this.render();
    const current = () => this.current(epoch, scope, connectionId, controller);
    try { await fn(controller.signal, current); }
    catch (error) { if (current()) { this.state = null; this.notice = error?.code === 'permission_denied' ? '控制权限已失效，请刷新读取范围' : error?.code === 'stale_precondition' ? staleNotice : '暂时无法核实送达状态'; if (error?.code === 'permission_denied') { this.outbox.items = this.outbox.items.filter(i => i.key !== controlKey(this.target)); this.outbox.save(); } } }
    finally { if (current()) { this.busy = false; this.render(); const pending = this.items().some(i => ['local', 'recorded', 'invoking', 'unknown'].includes(i.status)); if (pending) this.timer = setTimeout(() => void this.refresh(), this.pollMs); } }
  }
  items() { return this.target && this.work ? this.outbox.list(this.target, this.work) : []; }
  acceptFact(item, result) {
    const f = result.fact;
    if (f === null) { item.status = 'unknown'; this.outbox.save(); return; }
    if (!factValid(f, item.request)) throw new Error('invalid delivery fact');
    // Copy only the reviewed delivery DTO; raw errors and submitted text are never facts.
    item.fact = Object.fromEntries(['request_id', 'operation_id', 'work', 'action', 'expires_at', 'delivery_status', 'attempt_id', 'connector_epoch', 'native_client_message_id', 'native_interface_version', 'expected_turn_id', 'receipt', 'reconciliation', 'error_code', 'observed_at'].map(k => [k, f[k]])); item.status = f.delivery_status; this.outbox.save();
    if (f.delivery_status === 'rejected' && f.error_code === 'stale_precondition') {
      if (!this.draft) this.draft = item.request.input.text;
      this.notice = staleNotice;
    }
  }
  async refresh() {
    return this.run((signal, current) => this.refreshCurrent(signal, current));
  }
  async refreshCurrent(signal, current) {
      // Queries never apply or change the originally submitted action/turn/epoch.
      for (const item of this.items().filter(i => ['local', 'recorded', 'invoking', 'unknown'].includes(i.status))) {
        const result = await this.net.collaborationControl('query', { ...this.base(), action: item.request.action, operation_id: item.request.operation_id }, signal);
        if (!current()) return; this.acceptFact(item, result);
      }
      const validate = state => {
        const snapshot = state.snapshot, limitations = state.limitations;
        if (!keysOnly(state, ['ok', 'auth_scope', 'target', 'authorization_revision', 'connector_epoch', 'native_interface_version', 'snapshot', 'allowed_actions', 'limitations']) || state.auth_scope !== this.scope || !keysOnly(state.target, ['endpoint_id', 'work']) || !keysOnly(snapshot, ['state', 'turn_id', 'revision', 'work', 'connector_epoch', 'source', 'observed_at', 'identity_provenance']) || !workValid(snapshot.work) || snapshot.source !== 'codex.live' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !['none', 'observed_turn_started', 'history_candidate'].includes(snapshot.identity_provenance) || (snapshot.turn_id !== undefined && !idValid(snapshot.turn_id)) || (snapshot.observed_at !== null && (typeof snapshot.observed_at !== 'string' || !Number.isFinite(Date.parse(snapshot.observed_at)))) || (snapshot.state !== 'unknown' && snapshot.observed_at === null) || !keysOnly(limitations, ['atomic_idle_start', 'cancel', 'queue', 'runtime_state', 'subscription_state']) || limitations.atomic_idle_start !== false || limitations.cancel !== false || limitations.queue !== false || !['unknown', 'observed'].includes(limitations.runtime_state) || !['unknown', 'observed'].includes(limitations.subscription_state)) throw new Error('invalid control state');
        if (!sameWork(state.target?.work, this.work) || state.target.endpoint_id !== this.target.endpoint_id || !sameWork(state.snapshot?.work, this.work) || state.authorization_revision !== this.target.authorization_revision || !idValid(state.connector_epoch) || !idValid(state.native_interface_version) || state.snapshot.connector_epoch !== state.connector_epoch || !['unknown', 'idle', 'active', 'approval_required'].includes(state.snapshot.state) || !Array.isArray(state.allowed_actions) || state.allowed_actions.some(a => !this.target.actions.includes(a)) || (state.snapshot.state === 'active' && (!idValid(state.snapshot.turn_id) || !['observed_turn_started', 'history_candidate'].includes(state.snapshot.identity_provenance)))) throw new Error('invalid control state');
      };
      let stateAction = this.target.actions.includes('send_input') ? 'send_input' : 'steer';
      let state = await this.net.collaborationControl('state', { ...this.base(), action: stateAction }, signal);
      if (!current()) return; validate(state);
      const intended = state.snapshot.state === 'active' ? 'steer' : state.snapshot.state === 'idle' ? 'send_input' : null;
      if (intended && intended !== stateAction && this.target.actions.includes(intended)) {
        stateAction = intended;
        state = await this.net.collaborationControl('state', { ...this.base(), action: stateAction }, signal);
        if (!current()) return; validate(state);
      }
      // The epoch belongs to the state action's lease. If the turn changed during
      // the second observation, action() stays disabled until another check.
      this.state = state; this.stateAction = stateAction; this.notice = '';
      return true;
  }
  async submit() {
    if(this.image?.initializing){this.image.reject('图片准备中，请稍后发送');return;}
    if(this.image?.handlesSend){
      // Explicit submit commits the current IME candidate, including keyboard submits.
      const input=this.draftInput;if(input){input.blur();if(this.draft!==input.value){this.draft=input.value;this.onDraftSave?.(true);}}
      const blocked=this.offline?'连接已断开，请连接后发送':this.busy?'正在检查会话，请稍后发送':this.doc.hidden?'请返回会话后发送图片':!this.visible?'会话已关闭，请重新打开':!this.target||this.scope!==this.net.currentScope||!this.net.connectionId?'会话授权已变化，请重新打开':this.composing?'请确认输入后发送图片':null;
      if(blocked){this.image.reject(blocked);return;}
      await this.image.send(this.draft);return;
    }
    const text = this.draft;
    if (!text.trim() || this.composing || this.busy || this.offline || !this.target || this.scope !== this.net.currentScope || !this.net.connectionId || this.doc.hidden) return;
    await this.run(async (signal, current) => {
      // One run owns both observation and apply, including the action-specific lease.
      if (!await this.refreshCurrent(signal, current) || !current()) return;
      const action = this.action();
      if (!action) { this.notice = '暂时无法确定会话状态，原文已保留，请检查状态后再发送。'; return; }
      const request = { request_id: this.id(), operation_id: this.id(), work: { ...this.work }, action, input: { text }, expires_at: this.now() + TTL, ...(action === 'steer' ? { expected_turn_id: this.state.snapshot.turn_id } : {}) };
      const item = { key: controlKey(this.target), request, expected_connector_epoch: this.state.connector_epoch, created: this.now(), status: 'local', fact: null };
      if (bytes({ ...this.base(), request, expected_connector_epoch: item.expected_connector_epoch }) > 64 * 1024) { this.notice = '消息过长，请缩短后发送'; return; }
      try { this.outbox.add(item); } catch { this.notice = '本地待发送空间不足'; return; }
      if ((this.onDraftSubmitted && !this.outbox.savedReliably()) || this.onDraftSubmitted?.() === false) { this.outbox.items = this.outbox.items.filter(i => i !== item); this.outbox.save(); this.notice = '暂时无法保存草稿，请稍后再发送'; return; }
      if (this.draft === text) this.draft = ''; else this.onDraftSave?.();
      // Crossing the human channel boundary can leave delivery unknown, even when aborted.
      item.status = 'unknown'; this.outbox.save(); this.render();
      let result;
      try { result = await this.net.collaborationControl('apply', { ...this.base(), request, expected_connector_epoch: item.expected_connector_epoch }, signal); }
      catch (error) { if (current() && error?.code === 'stale_precondition' && !this.draft) this.draft = text; throw error; }
      if (!current()) return; this.acceptFact(item, result);
    });
  }
  async recover(item, operation) {
    return this.run(async (signal, current) => { const result = await this.net.collaborationControl(operation, { ...this.base(), action: item.request.action, operation_id: item.request.operation_id }, signal); if (current()) this.acceptFact(item, result); });
  }
  showHistory() { this.historyShown = true; this.render(); if (this.history) this.history.open = true; }
  render() {
    const d = this.doc;
    if (!this.target) { this.clearComposer(); this.root.append(element(d, 'p', '只读会话')); return; }
    if (!this.form) {
      this.details = element(d, 'div');
      this.history = element(d, 'details'); this.history.append(element(d, 'summary', '发送记录'));
      const history = this.history;
      history.addEventListener('toggle', () => { if (this.history === history && !history.open) { this.historyShown = false; history.hidden = true; } });
      this.records = element(d, 'div'); this.history.append(this.records);
      const form = this.form = element(d, 'form'), input = this.draftInput = element(d, 'textarea');
      input.setAttribute('aria-label', '发给桌面会话的消息');
      input.oninput = () => { if (this.draftInput === input) { this.draft = input.value; this.onDraftSave?.(true); } };
      input.addEventListener('compositionstart', () => { if (this.draftInput === input) this.composing = true; });
      input.addEventListener('compositionend', () => { if (this.draftInput === input) { this.composing = false; this.draft = input.value; this.onDraftSave?.(true); this.onDraftReady?.(); this.sendButton.disabled = this.busy || !!this.offline; } });
      // A tap must be able to commit the IME candidate before submitting.
      input.addEventListener('blur', () => { if (this.draftInput === input) { this.composing = false; this.draft = input.value; this.onDraftSave?.(true); this.onDraftReady?.(); } });
      this.sendButton = element(d, 'button'); this.sendButton.type = 'submit';
      this.sendButton.addEventListener('pointerdown', () => { if (this.composing) input.blur(); });
      form.onsubmit = event => { event.preventDefault(); void this.submit(); };
      this.imageRow=element(d,'div',undefined,'desktop-image-selection');this.imageName=element(d,'span');this.imageRemove=element(d,'button','×');this.imageRemove.type='button';this.imageRemove.setAttribute('aria-label','移除图片');this.imageRemove.onclick=()=>this.image?.remove();this.imageRow.append(this.imageName,this.imageRemove);
      this.imageNotice=element(d,'p',undefined,'desktop-image-notice');this.imageNotice.setAttribute('role','status');this.imageButton=element(d,'button','图片');this.imageButton.type='button';this.imageButton.setAttribute('aria-label','选择图片');this.imageButton.onclick=()=>void this.image?.pick();form.append(this.imageRow,input,this.imageButton,this.sendButton,this.imageNotice);
      this.refreshButton = element(d, 'button', '检查状态'); this.refreshButton.type = 'button'; this.refreshButton.onclick = () => void this.refresh();
      this.root.append(this.details, form, this.refreshButton, this.history);
    }
    this.details.replaceChildren();
    const action = this.action();
    if (!this.notice && this.state?.snapshot?.state === 'approval_required') this.details.append(element(d, 'p', '请在电脑上确认'));
    const items = this.items(); this.records.replaceChildren(); this.history.hidden = !items.length || !this.historyShown;
    const latest = items.at(-1);
    if (latest && ['local', 'recorded', 'invoking', 'unknown'].includes(latest.status)) this.details.append(element(d, 'small', statusText[latest.status]));
    else if (latest?.status === 'rejected' && !this.notice) this.details.append(element(d, 'p', '未发送'));
    if (latest && ['unknown', 'rejected'].includes(latest.status)) { const inspect = element(d, 'button', '查看'); inspect.type = 'button'; inspect.onclick = () => this.showHistory(); this.details.append(inspect); }
    for (const item of items) {
      const matched = this.messages.some(message => mappedMessage(item, message));
      const row = element(d, 'article', undefined, 'desktop-operation'); row.dataset.operation = item.request.operation_id;
      if (!matched) row.append(element(d, 'div', item.request.input.text, 'desktop-text'));
      row.append(element(d, 'small', `${item.status === 'accepted' && item.fact?.receipt?.accepted_by !== 'native' ? '发送结果待确认' : statusText[item.status]}${matched ? ' · 已显示在会话中' : ''}`));
      if (item.fact?.delivery_status === 'rejected' && item.fact.error_code === 'stale_precondition') row.append(element(d, 'small', staleNotice));
      if (item.fact?.reconciliation) { row.append(element(d, 'small', '已检查发送结果')); }
      if (['local', 'recorded', 'invoking', 'unknown'].includes(item.status)) for (const [op, label] of [['query', '查询结果'], ['reconcile', '核查结果']]) { const button = element(d, 'button', label); button.type = 'button'; button.disabled = this.busy; button.onclick = () => void this.recover(item, op); row.append(button); }
      this.records.append(row);
    }
    if (this.notice) this.details.append(element(d, 'p', this.notice, 'desktop-control-notice'));
    // Never detach or overwrite a live composer during a background refresh.
    if (!this.composing && this.draftInput.value !== this.draft) this.draftInput.value = this.draft;
    this.draftInput.placeholder = action === 'steer' ? '补充要求…' : '发消息…';
    this.sendButton.textContent = this.image?.busy ? '发送中…' : '发送'; this.sendButton.disabled = this.busy || !!this.offline || !!this.image?.busy || !!this.image?.initializing;
    this.imageButton.hidden=!this.image;this.imageButton.disabled=this.busy||!!this.offline||!!this.image?.busy||!!this.image?.initializing||!!this.image?.op;this.imageRow.hidden=!this.image?.selection&&!this.image?.failedImage;this.imageName.textContent=this.image?.selection?.name||(this.image?.failedImage?'图片未选中':'');this.imageRemove.disabled=this.busy||!!this.image?.busy||!!this.image?.initializing;this.imageNotice.textContent=this.image?.notice||'';this.imageNotice.hidden=!this.image?.notice;
    this.refreshButton.hidden = !!action; this.refreshButton.disabled = this.busy; this.onDraftReady?.();
  }
}

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const revision = 'b'.repeat(64);
const target = { version: 1, device_id: 'device:one', endpoint_id: 'one', grant_state: 'ready', authorization_revision: revision, actions: ['send_input', 'steer'], capabilities: ['state', 'apply', 'query', 'reconcile'] };
const work = { node_id: 'one', endpoint_id: 'one', kind: 'conversation', native_id: 'thread-one' };
const state = active => ({ target: { endpoint_id: 'one', work }, authorization_revision: revision, connector_epoch: `epoch-${active ? 'steer' : 'send_input'}`, native_interface_version: 'v1', limitations: { atomic_idle_start: false, cancel: false, queue: false, runtime_state: 'observed', subscription_state: 'observed' }, snapshot: { work, source: 'codex.live', observed_at: '2026-10-09T01:00:00Z', revision: 1, connector_epoch: `epoch-${active ? 'steer' : 'send_input'}`, state: active ? 'active' : 'idle', ...(active ? { turn_id: 'turn-one' } : {}), identity_provenance: active ? 'observed_turn_started' : 'none' }, allowed_actions: ['send_input', 'steer'] });
function fact(request, status = 'accepted') { return { request_id: request.request_id, operation_id: request.operation_id, work: request.work, action: request.action, expires_at: request.expires_at, expected_turn_id: request.expected_turn_id ?? null, delivery_status: status, connector_epoch: 'epoch-one', native_client_message_id: 'client-one', native_interface_version: 'v1', attempt_id: 'attempt-one', error_code: null, observed_at: Date.now(), receipt: status === 'accepted' ? { accepted_by: 'native', native_turn_id: 'turn-one', native_message_id: 'item-one', correlation: 'stable_message_id' } : null, reconciliation: null }; }
async function fixture(page, { active = false, grant = true } = {}) {
  const bundled = await build({ stdin: { contents: 'import { DesktopWork } from "./desktop-work.js"; import { DesktopControl } from "./desktop-control.js"; Object.assign(window,{DesktopWork,DesktopControl});', resolveDir: fileURLToPath(new URL('../../js', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const calls = []; let last, delivery = 'accepted', hold = false, release, corrupt = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/api/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); const op = req.url.split('/').pop(); calls.push({ op, input });
      if (op === 'apply') { expect(input.expected_connector_epoch).toBe(`epoch-${input.request.action}`); last = input.request; if (hold) await new Promise(resolve => { release = resolve; }); }
      res.setHeader('Content-Type', 'application/json');
      if (op === 'apply' && delivery === 'timeout') { res.statusCode = 504; res.end(JSON.stringify({ ok: false, error: { code: 'timeout' } })); return; }
      let data = op === 'state' ? { ...state(active), connector_epoch: `epoch-${input.action}`, snapshot: { ...state(active).snapshot, connector_epoch: `epoch-${input.action}` } } : { fact: last ? fact(last, delivery === 'timeout' ? 'unknown' : delivery) : null };
      if (corrupt && data.fact) data.fact.work = { ...work, native_id: 'other' };
      res.end(JSON.stringify({ ok: true, auth_scope: 'scope-one', ...data })); return;
    }
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0].text); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<main id="read"></main><script type="module" src="/fixture.js"></script>'); return; }
    try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL(`../../${req.url.slice(1)}`, import.meta.url))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  async function mount() { await page.goto(url); await page.waitForFunction(() => window.DesktopControl);
  await page.evaluate(({ target, work, grant }) => {
    window.net = { endpoint: location.origin, currentScope: 'scope-one', connectionId: 'connectionId-one', async collaborationControl(op, input, signal) { const response = await fetch(`/api/collaboration/control/${op}`, { method: 'POST', body: JSON.stringify(input), signal }); const data = await response.json(); if (!response.ok) throw Object.assign(new Error('HTTP'), { code: data.error.code }); return data; } };
    window.control = new DesktopControl(document, net, { pollMs: 100 }); window.target = target; window.work = work;
    document.body.append(control.update(grant ? [target] : [], { device_id: target.device_id }, work));
  }, { target, work, grant });
  if (grant) await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  }
  await mount();
  return { calls, mount, set delivery(v) { delivery = v; }, set corrupt(v) { corrupt = v; }, hold() { hold = true; }, release() { release?.(); }, async close() { release?.(); await page.evaluate(() => control.stop()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const send = async page => { await page.getByRole('textbox', { name: '发给桌面会话的消息' }).fill('同样的正文'); await page.getByRole('button', { name: '发送', exact: true }).click(); };
test('one explicit submit creates one persistent operation and native receipt is separate from result', async ({ page }) => {
  const f = await fixture(page, { active: true });
  try {
    f.hold(); await send(page); await expect.poll(() => f.calls.filter(c => c.op === 'apply').length).toBe(1);
    await page.evaluate(() => { void control.submit(); void control.submit(); });
    const apply = f.calls.find(c => c.op === 'apply').input; expect(apply.request.action).toBe('steer'); expect(apply.request.expected_turn_id).toBe('turn-one'); expect(apply.expected_connector_epoch).toBe('epoch-steer'); expect(apply).not.toHaveProperty('action'); expect(apply).not.toHaveProperty('caller');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ash.desktop.control-outbox.v1'))); expect(saved.items).toHaveLength(1); expect(saved.items[0].request.operation_id).toBe(apply.request.operation_id);
    f.release(); await expect(page.locator('.desktop-operation')).toContainText('已发送'); expect(f.calls.filter(c => c.op === 'apply')).toHaveLength(1);
    expect(await page.evaluate(() => control.history.open)).toBe(false);
    await expect(page.locator('.desktop-operation')).not.toBeVisible();
    await page.evaluate(() => control.showHistory());
    await page.evaluate(() => { window.composerBefore = control.draftInput; control.render(); });
    expect(await page.evaluate(() => [control.history.open, control.draftInput === composerBefore])).toEqual([true, true]);
    await expect(page.locator('.desktop-operation')).toBeVisible();
    await page.getByText('发送记录', { exact: true }).click();
    await expect(page.getByText('发送记录', { exact: true })).toBeHidden();
    await page.evaluate(() => control.render());
    await expect(page.getByText('发送记录', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '检查状态', exact: true })).toBeHidden();
  } finally { await f.close(); }
});
test('timeout and reload use only query/reconcile with original operation and no input text', async ({ page }) => {
  const f = await fixture(page);
  try {
    f.delivery = 'timeout'; await send(page); await expect(page.locator('.desktop-operation')).toContainText('发送结果待确认');
    const original = f.calls.find(c => c.op === 'apply').input.request.operation_id;
    await expect.poll(() => f.calls.filter(c => c.op === 'query').length).toBeGreaterThan(0);
    await page.evaluate(() => { control.stop(); window.control = new DesktopControl(document, net, { pollMs: 100 }); document.body.replaceChildren(control.update([target], { device_id: target.device_id }, work)); });
    await expect(page.locator('.desktop-operation')).toContainText('发送结果待确认');
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await expect(page.getByRole('button', { name: '核查结果', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '核查结果', exact: true }).click();
    await expect.poll(() => f.calls.filter(c => c.op === 'reconcile').length).toBe(1);
    expect(f.calls.filter(c => c.op === 'apply')).toHaveLength(1);
    for (const { input } of f.calls.filter(c => ['query', 'reconcile'].includes(c.op))) { expect(input.operation_id).toBe(original); expect(input).not.toHaveProperty('request'); expect(input).not.toHaveProperty('input'); }
  } finally { await f.close(); }
});
test('late grant/scope changes fence apply response and erase scoped local text', async ({ page }) => {
  const f = await fixture(page);
  try {
    f.hold(); await send(page); await expect.poll(() => f.calls.some(c => c.op === 'apply')).toBe(true);
    await page.evaluate(() => { net.currentScope = 'scope-two'; control.update([], { device_id: target.device_id }, work); });
    f.release(); await page.waitForTimeout(150); await expect(page.locator('.desktop-control')).toContainText('只读会话'); await expect(page.locator('.desktop-operation')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('ash.desktop.control-outbox.v1'))).not.toContain('同样的正文');
  } finally { await f.close(); }
});
test('same text never merges; full work and stable client/item mapping merge only optimistic body', async ({ page }) => {
  const f = await fixture(page);
  try {
    await send(page); await expect(page.locator('.desktop-operation')).toContainText('已发送');
    await page.evaluate(() => control.update([target], { device_id: target.device_id }, work, [{ work, role: 'user', text: '同样的正文', turn_id: 'turn-one', source_message_id: 'other' }]));
    await expect(page.locator('.desktop-operation .desktop-text')).toHaveCount(1);
    await page.evaluate(() => control.update([target], { device_id: target.device_id }, work, [{ work: { ...work, native_id: 'wrong' }, role: 'user', source_client_message_id: 'client-one' }]));
    await expect(page.locator('.desktop-operation .desktop-text')).toHaveCount(1);
    await page.evaluate(() => control.update([target], { device_id: target.device_id }, work, [{ work, role: 'user', turn_id: 'turn-one', source_message_id: 'item-one' }]));
    await expect(page.locator('.desktop-operation .desktop-text')).toHaveCount(0); await expect(page.locator('.desktop-operation')).toContainText('已显示在会话中');
  } finally { await f.close(); }
});
test('hide and work switch stop polling; wrong target facts cannot become accepted', async ({ page }) => {
  const f = await fixture(page);
  try {
    f.corrupt = true; await send(page); await expect(page.locator('.desktop-operation')).toContainText('发送结果待确认'); await expect(page.locator('.desktop-operation')).not.toContainText('已发送');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const count = f.calls.length; await page.waitForTimeout(250); expect(f.calls).toHaveLength(count);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); control.update([], { device_id: 'device:two' }, { ...work, node_id: 'two', endpoint_id: 'two' }); });
    await expect(page.locator('.desktop-operation')).toHaveCount(0);
  } finally { await f.close(); }
});
test('no control grant leaves real read UI operational without composer or control calls', async ({ page }) => {
  const f = await fixture(page, { grant: false });
  try {
    await page.evaluate(() => {
      const readTarget = { device_id: 'device:one', node_id: 'one', endpoint_id: 'one', name: '电脑', authorization_generation: 1, authorization_revision: 'a'.repeat(64), authorization_state: 'ready', source: 'codex.saved_history', runtime_state: 'unknown', control: 'unsupported', actions: ['list_work', 'read_work'] };
      net.collaborationEndpoints = async () => ({ auth_scope: net.currentScope, targets: [readTarget] });
      net.collaborationControlEndpoints = async () => ({ auth_scope: net.currentScope, control_targets: [] });
      net.collaborationRead = async (_target, w) => ({ auth_scope: net.currentScope, target: readTarget, page: { items: w ? [{ turn_id: 't', messages: [{ work, turn_id: 't', source_message_id: 'm', role: 'assistant', text: '历史可读取' }] }] : [{ work, title: '已有会话', cwd: '/project', updated_at: Date.now() }], next_cursor: null, observed_at: new Date().toISOString(), source: 'codex.saved_history', completeness: 'source_page', runtime_state: 'unknown' } });
      document.body.replaceChildren(document.createElement('section')); window.reader = new DesktopWork(document.body.firstChild, net, { pollMs: 10000 }); reader.open();
    });
    await page.getByRole('button', { name: '电脑 · Codex', exact: true }).click(); await page.getByRole('button', { name: /已有会话/ }).click(); await expect(page.locator('.desktop-messages')).toContainText('历史可读取'); await expect(page.locator('textarea')).toHaveCount(0); expect(f.calls).toHaveLength(0); await page.evaluate(() => reader.close());
  } finally { await f.close(); }
});
test('recorded and invoking remain waiting; rejected never says delivered or completed', async ({ page }) => {
  const f = await fixture(page);
  try {
    f.delivery = 'recorded'; await send(page); await expect(page.locator('.desktop-operation')).toContainText('等待发送');
    f.delivery = 'invoking'; await expect(page.locator('.desktop-operation')).toContainText('发送中');
    f.delivery = 'rejected'; await expect(page.locator('.desktop-operation')).toContainText('未发送'); await expect(page.locator('.desktop-operation')).not.toContainText('已发送'); expect(f.calls.filter(c => c.op === 'apply')).toHaveLength(1);
  } finally { await f.close(); }
});
async function mountReader(page, selected=true) {
  await page.evaluate(selected => {
    const readTarget = { device_id: 'device:one', node_id: 'one', endpoint_id: 'one', name: '电脑', authorization_generation: 1, authorization_revision: 'a'.repeat(64), authorization_state: 'ready', source: 'codex.saved_history', runtime_state: 'unknown', control: 'unsupported', actions: ['list_work', 'read_work'] };
    net.collaborationEndpoints = async () => ({ auth_scope: net.currentScope, targets: [readTarget] });
    net.collaborationControlEndpoints = async () => ({ auth_scope: net.currentScope, control_targets: [target] });
    net.collaborationRead = async () => ({ auth_scope: net.currentScope, target: readTarget, page: { items: [], next_cursor: null, observed_at: new Date().toISOString(), source: 'codex.saved_history', completeness: 'source_page', runtime_state: 'unknown' } });
    window.reader = new DesktopWork(document.querySelector('#read'), net, { control, pollMs: 100000 });
    if(!selected)return;reader.opened = true; reader.target = readTarget; reader.work = work; reader.targets = [readTarget]; reader.controlTargets = [target]; reader.render('已同步');
  },selected);
}
test('background control and history refresh preserve composer focus, selection and editable draft', async ({ page }) => {
  const f = await fixture(page);
  try {
    await mountReader(page);
    const input = page.getByRole('textbox', { name: '发给桌面会话的消息' });
    await input.fill('持续输入的草稿');
    await page.evaluate(() => {
      window.originalComposer = control.draftInput; window.blurs = 0;
      originalComposer.focus(); originalComposer.setSelectionRange(2, 4); originalComposer.addEventListener('blur', () => blurs++);
      const original = net.collaborationControl.bind(net);
      let release; const gate = new Promise(resolve => { release = resolve; }); window.releaseState = release;
      net.collaborationControl = async (...args) => { if (args[0] === 'state') await gate; return original(...args); };
      window.refreshing = control.refresh();
    });
    await expect(input).toBeEnabled(); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await page.evaluate(() => { reader.render('后台读取中'); reader.render('后台读取中'); });
    expect(await page.evaluate(() => [control.draftInput === originalComposer, document.activeElement === originalComposer, originalComposer.selectionStart, originalComposer.selectionEnd, blurs])).toEqual([true, true, 2, 4, 0]);
    await page.keyboard.insertText('新增');
    await page.evaluate(async () => { releaseState(); await refreshing; await reader.refresh(); clearTimeout(reader.timer); });
    expect(await page.evaluate(() => [control.draftInput === originalComposer, document.activeElement === originalComposer, blurs, originalComposer.value === control.draft])).toEqual([true, true, 0, true]);
    await expect(input).toHaveValue('持续新增的草稿');
    await page.evaluate(() => control.network('offline'));
    await expect(input).toBeEnabled(); await page.keyboard.insertText('继续'); await expect(input).toHaveValue('持续新增继续的草稿');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  } finally { await page.evaluate(() => reader.cancel()); await f.close(); }
});
test('composition survives refresh and old composition events cannot restore a cross-scope draft', async ({ page }) => {
  const f = await fixture(page);
  try {
    await mountReader(page);
    const input = page.getByRole('textbox', { name: '发给桌面会话的消息' }); await input.fill('原文');
    await page.evaluate(async () => {
      window.originalComposer = control.draftInput; window.blurs = 0;
      originalComposer.focus(); originalComposer.addEventListener('blur', () => blurs++);
      originalComposer.dispatchEvent(new CompositionEvent('compositionstart', { data: 'zhong' }));
      // Candidate text can precede the next input event; render must not assign the older draft.
      originalComposer.value = '原文中文候选'; originalComposer.setSelectionRange(4, 6);
      reader.render('同步中'); await control.refresh(); await reader.refresh(); clearTimeout(reader.timer);
    });
    expect(await page.evaluate(() => [control.draftInput === originalComposer, document.activeElement === originalComposer, originalComposer.value, originalComposer.selectionStart, originalComposer.selectionEnd, control.composing, blurs])).toEqual([true, true, '原文中文候选', 4, 6, true, 0]);
    await page.evaluate(() => originalComposer.dispatchEvent(new CompositionEvent('compositionend', { data: '中文候选' })));
    expect(await page.evaluate(() => control.draft)).toBe('原文中文候选');
    await page.evaluate(() => {
      originalComposer.dispatchEvent(new CompositionEvent('compositionstart'));
      net.currentScope = 'scope-two'; control.update([target], { device_id: target.device_id }, work);
      originalComposer.value = '旧范围私有文本'; originalComposer.dispatchEvent(new CompositionEvent('compositionend')); originalComposer.dispatchEvent(new InputEvent('input'));
    });
    await expect(input).toHaveValue(''); expect(await page.evaluate(() => control.draft)).toBe('');
    expect(await page.evaluate(() => control.draftInput === originalComposer)).toBe(false);
  } finally { await page.evaluate(() => reader.cancel()); await f.close(); }
});

test('send remains reachable after an unknown observation and checks fresh active state before apply', async ({ page }) => {
  const f = await fixture(page, { active: true });
  try {
    await page.evaluate(() => { control.state = null; control.render(); });
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await send(page);
    await expect.poll(() => f.calls.filter(c => c.op === 'apply').length).toBe(1);
    const request = f.calls.find(c => c.op === 'apply').input.request;
    expect(request.action).toBe('steer'); expect(request.expected_turn_id).toBe('turn-one');
  } finally { await f.close(); }
});

test('tapping send commits a composing textarea without leaving the button permanently disabled', async ({ page }) => {
  const f = await fixture(page, { active: true });
  try {
    const input = page.getByRole('textbox', { name: '发给桌面会话的消息' });
    await input.focus();
    await page.evaluate(() => {
      control.draftInput.dispatchEvent(new CompositionEvent('compositionstart'));
      control.draftInput.value = '追加中文要求';
      control.draftInput.dispatchEvent(new InputEvent('input', { isComposing: true }));
      control.render();
    });
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.calls.filter(c => c.op === 'apply').length).toBe(1);
    expect(f.calls.find(c => c.op === 'apply').input.request.input.text).toBe('追加中文要求');
  } finally { await f.close(); }
});
test('shared link waits for explicit work selection, appends original draft once and survives refresh offline', async ({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);await page.getByRole('textbox',{name:'发给桌面会话的消息'}).fill('原来的要求');
  expect(await page.evaluate(()=>reader.receiveShare({id:'share-one',text:'https://example.com/article'}))).toBe(true);
  await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveCount(0);
  await page.evaluate(()=>{reader.selectTarget(reader.targets[0]);reader.selectWork({work,title:'已有会话'});});
  const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await expect(input).toHaveValue('原来的要求\n\nhttps://example.com/article');
  expect(await page.evaluate(()=>reader.receiveShare({id:'share-one',text:'https://example.com/article'}))).toBe(true);
  await input.fill('原来的要求\n\nhttps://example.com/article\n补充要求');
  await page.evaluate(async()=>{await reader.refresh();reader.network('offline');});
  await expect(input).toHaveValue('原来的要求\n\nhttps://example.com/article\n补充要求');expect(f.calls.some(c=>c.op==='apply')).toBe(false);
  await page.evaluate(()=>control.network('online'));await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>f.calls.filter(c=>c.op==='apply').length).toBe(1);expect(f.calls.find(c=>c.op==='apply').input.request.input.text).toBe('原来的要求\n\nhttps://example.com/article\n补充要求');
  await page.evaluate(()=>{net.currentScope='scope-two';reader.reset();});expect(await page.evaluate(()=>[reader.sharedDrafts.pending,reader.sharedDrafts.saved.size])).toEqual(['',0]);
  await page.evaluate(()=>{net.currentScope=null;});expect(await page.evaluate(()=>reader.receiveShare({id:'share-two',text:'https://example.com'}))).toBe(false);
 }finally{await f.close();}
});
test('pending share capacity has explicit receive retry and never automatically applies',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);
  const result=await page.evaluate(()=>{
   window.firstShare='https://example.com/'+ 'a'.repeat(32768-'https://example.com/'.length);
   window.secondShare='https://example.com/'+ 'b'.repeat(32768-'https://example.com/'.length);
   const first=reader.receiveShare({id:'capacity-one',text:firstShare});
   window.pendingNative={id:'capacity-two',text:secondShare};
   window.__ashShareText={flush(){if(reader.receiveShare(pendingNative))pendingNative=null;}};
   const second=reader.receiveShare(pendingNative);return[first,second];
  });expect(result).toEqual([true,false]);
  await expect(page.getByRole('button',{name:'重试接收',exact:true})).toBeVisible();await expect(page.getByRole('status')).toContainText('暂时无法接收');
  await page.evaluate(()=>{reader.selectTarget(reader.targets[0]);reader.selectWork({work,title:'已有会话'});});
  await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveValue(await page.evaluate(()=>firstShare));
  // The user clears the first draft; retry only accepts the native-held share.
  await page.getByRole('textbox',{name:'发给桌面会话的消息'}).fill('');await page.getByRole('button',{name:'重试接收',exact:true}).click();
  expect(await page.evaluate(()=>pendingNative)).toBeNull();await expect(page.getByRole('button',{name:'重试接收',exact:true})).toHaveCount(0);
  await page.evaluate(()=>{reader.selectTarget(reader.targets[0]);reader.selectWork({work,title:'已有会话'});});
  await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveValue(await page.evaluate(()=>secondShare));expect(f.calls.some(c=>c.op==='apply')).toBe(false);
 }finally{await f.close();}
});

test('ordinary composer reload restores only its scoped grant and explicit send clears it',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await input.fill('重载前普通草稿');
  await f.mount();await mountReader(page);await expect(input).toHaveValue('重载前普通草稿');expect(f.calls.some(c=>c.op==='apply')).toBe(false);
  await page.evaluate(()=>{net.currentScope='another-scope';control.update([target],{device_id:target.device_id},work);});await expect(input).toHaveValue('');
  await page.evaluate(()=>{net.currentScope='scope-one';control.update([{...target,authorization_revision:'c'.repeat(64)}],{device_id:target.device_id},work);});await expect(input).toHaveValue('');
  await page.evaluate(()=>control.update([target],{device_id:target.device_id},work));await expect(input).toHaveValue('重载前普通草稿');
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>f.calls.filter(c=>c.op==='apply').length).toBe(1);
  await f.mount();await mountReader(page);await expect(input).toHaveValue('');expect(f.calls.filter(c=>c.op==='apply')).toHaveLength(1);
 }finally{await f.close();}
});
test('failed draft storage keeps empty composer editable and rejects share ACK',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await input.fill('previous');await input.focus();
  await page.evaluate(()=>{window.before=control.draftInput;reader.sharedDrafts.storage={getItem(){return null;},setItem(){throw Error('full');}};});
  await input.fill('');await page.evaluate(()=>control.render());await expect(input).toHaveValue('');expect(await page.evaluate(()=>control.draftInput===before&&document.activeElement===before)).toBe(true);
  expect(await page.evaluate(()=>reader.receiveShare({id:'failure',text:'link'}))).toBe(false);expect(f.calls.some(c=>c.op==='apply')).toBe(false);
 }finally{await f.close();}
});

test('pending acknowledged share reload opens the list once and waits for explicit destination',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);expect(await page.evaluate(()=>reader.receiveShare({id:'reload-share',text:'reload link'}))).toBe(true);
  await f.mount();await mountReader(page,false);
  expect(await page.evaluate(()=>reader.restoreSharedDrafts())).toBe(true);await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveCount(0);expect(f.calls.some(c=>c.op==='apply')).toBe(false);
  expect(await page.evaluate(()=>reader.restoreSharedDrafts())).toBe(false);
  await page.evaluate(()=>{reader.selectTarget(reader.targets[0]);reader.selectWork({work,title:'已有会话'});});await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveValue('reload link');
 }finally{await f.close();}
});

test('operation storage failure preserves draft and prevents apply',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);await page.getByRole('textbox',{name:'发给桌面会话的消息'}).fill('操作记录失败仍保留');
  await page.evaluate(()=>{control.outbox.storage={getItem(){return null;},setItem(){throw Error('full');}};});await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('.desktop-control-notice')).toContainText('稍后再发送');expect(f.calls.some(c=>c.op==='apply')).toBe(false);await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveValue('操作记录失败仍保留');
  await f.mount();await mountReader(page);await expect(page.getByRole('textbox',{name:'发给桌面会话的消息'})).toHaveValue('操作记录失败仍保留');
 }finally{await f.close();}
});

test('inline single image keeps the original composer and only its explicit send delivers text plus image',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);
  await page.evaluate(async()=>{
   const {fakePort,uiRequest}=await import('/test/desktop-materials-fixture.js');const photoPort=fakePort();window.photoPort=photoPort;
   const selection={selection_id:'selected-image',name:'photo.png',media_type:'image/png',byte_length:1,sha256:'a'.repeat(64)};photoPort.selections=[selection];
   photoPort.submitInput=async input=>{photoPort.calls.push({method:'submitInput',input});const r=uiRequest(input.request_id);r.target={kind:'work',work};const ref={kind:'asset',asset_id:'photo',version:1,sha256:selection.sha256,byte_length:1,media_type:'image/png',display_name:'photo.png',provenance:[],expires_at:Date.now()+90000};r.assets=[{ref,readable:true,location:'destination',transfer:{version:1,transfer_id:'transfer',request_id:r.request_id,asset_id:'photo',asset_version:1,state:'committed',received_chunks:[],expires_at:ref.expires_at,receipt:{version:1,receipt_id:'receipt',transfer_id:'transfer',request_id:r.request_id,asset_id:'photo',asset_version:1,sha256:ref.sha256,byte_length:1,destination:r.target,received_at:10}}}];photoPort.records.set(r.request_id,r);return r;};
   control.stop();control.imagePortFactory=()=>photoPort;control.update([target],{device_id:target.device_id},work);
  });
  const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await expect(page.getByRole('button',{name:'选择图片',exact:true})).toBeEnabled();await input.fill('这张图是什么');await page.getByRole('button',{name:'选择图片',exact:true}).click();await expect(page.locator('.desktop-image-selection')).toContainText('photo.png');
  expect(await page.evaluate(()=>photoPort.calls.some(c=>['submitInput','sendInput'].includes(c.method)))).toBe(false);
  await input.focus();await page.evaluate(async()=>{window.photoInput=control.draftInput;photoInput.setSelectionRange(2,4);await control.refresh();});expect(await page.evaluate(()=>[control.draftInput===photoInput,document.activeElement===photoInput,photoInput.selectionStart,photoInput.selectionEnd])).toEqual([true,true,2,4]);
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(input).toHaveValue('');await expect(page.locator('.desktop-image-selection')).toBeHidden();
  expect(await page.evaluate(()=>photoPort.calls.filter(c=>c.method==='sendInput').length)).toBe(1);expect(f.calls.some(c=>c.op==='apply')).toBe(false);expect(await page.evaluate(()=>photoPort.calls.find(c=>c.method==='saveDraft').input.text)).toBe('这张图是什么');expect(await page.evaluate(()=>photoPort.calls.find(c=>c.method==='sendInput').input.target)).toEqual(work);
 }finally{await f.close();}
});
test('failed inline image pick blocks plain send until explicit removal',async({page})=>{
 const f=await fixture(page);try{
  await mountReader(page);await page.evaluate(async()=>{const {fakePort}=await import('/test/desktop-materials-fixture.js');const p=fakePort();p.selectFiles=async()=>{throw {code:'too_large'};};window.failedPhotoPort=p;control.stop();control.imagePortFactory=()=>p;control.update([target],{device_id:target.device_id},work);});
  const input=page.getByRole('textbox',{name:'发给桌面会话的消息'});await expect(page.getByRole('button',{name:'选择图片',exact:true})).toBeEnabled();await input.fill('图片要求原文');await page.getByRole('button',{name:'选择图片',exact:true}).click();await expect(page.locator('.desktop-image-selection')).toContainText('图片未选中');await expect(page.locator('.desktop-image-notice')).toContainText('不超过');
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(input).toHaveValue('图片要求原文');expect(f.calls.some(c=>c.op==='apply')).toBe(false);expect(await page.evaluate(()=>failedPhotoPort.calls.some(c=>['submitInput','sendInput'].includes(c.method)))).toBe(false);
  await page.getByRole('button',{name:'移除图片',exact:true}).click();await expect(page.locator('.desktop-image-selection')).toBeHidden();await page.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>f.calls.filter(c=>c.op==='apply').length).toBe(1);
 }finally{await f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Probe, Rpc, THREAD, guiInput, listenerEpoch, parseObserveMs } from './codex-gui-steer-probe.mjs';

const make = () => new Probe({ runId: 'fake-run', baseline: ['old'], now: 0 });
const ev = (method, item, turnId = 'new', threadId = THREAD) => ({ method, params: { threadId, turnId, item } });
const start = (p, id = 'new', thread = THREAD) => p.event({ method: 'turn/started', params: { threadId: thread, turn: { id, status: 'inProgress' } } }, 1);
const user = p => p.event(ev('item/completed', { id: 'base', type: 'userMessage', content: [{ type: 'text', text: guiInput(p.runId) }] }), 2);
const command = (p, patch = {}, method = 'item/started') => p.event(ev(method, { id: 'wait', type: 'commandExecution', command: 'sleep 25', status: 'inProgress', ...patch }), 3);
const ready = () => { const p = make(); start(p); user(p); command(p); return p; };

test('legal GUI turn steers once, duplicate events/acks are harmless, history correlates by clientId', () => {
  const p = ready(); start(p); command(p);
  const intent = p.intent(4); assert.equal(intent.expectedTurnId, 'new'); assert.equal(intent.threadId, THREAD);
  assert.equal(p.intent(5), null); assert.equal(p.calls, 1);
  p.receipt({ turnId: 'new' }); p.receipt({ turnId: 'new' });
  command(p, { status: 'completed', exitCode: 0 }, 'item/completed');
  p.event(ev('item/completed', { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `${p.base} ${p.append}` }), 6);
  p.event({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'new', status: 'completed' } } }, 7);
  assert.equal(p.history([{ id: 'new', status: 'completed', items: [
    { id: 'base', type: 'userMessage', content: [{ type: 'text', text: p.base }] },
    { id: 'append-native', type: 'userMessage', clientId: p.clientId },
    { id: 'wait', type: 'commandExecution', command: 'sleep 25', status: 'completed', exitCode: 0 },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `${p.base} ${p.append}` },
  ] }]), true);
  assert.equal(p.result().result, 'pass'); assert.equal(p.result().historyItemId, 'append-native');
});

for (const [name, change] of [
  ['wrong thread', p => { p.turns.clear(); start(p, 'foreign', 'other'); }],
  ['old turn', p => { p.turns.clear(); start(p, 'old'); }],
  ['missing marker', p => [...p.turns.values()][0].users.clear()],
  ['missing wait', p => [...p.turns.values()][0].commands.clear()],
  ['multiple new turns', p => start(p, 'new-2')],
  ['multiple base inputs', p => p.event(ev('item/completed', { id: 'second-base', type: 'userMessage', content: [{ type: 'text', text: p.base }] }), 4)],
  ['multiple waits', p => command(p, { id: 'second-wait' })],
  ['other command', p => command(p, { command: 'ls' })],
  ['wait ended', p => command(p, { status: 'completed', exitCode: 0 }, 'item/completed')],
  ['approval request', p => p.event({ id: 81, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } }, 4)],
  ['approval notification', p => p.event({ method: 'item/approvalRequested', params: { threadId: THREAD } }, 4)],
  ['approval active flag', p => p.event({ method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } }, 4)],
  ['disconnect', p => p.stop('disconnect')],
  ['expired observation', p => { p.deadline = 4; }],
  ['interrupted turn', p => p.event({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'new', status: 'interrupted' } } }, 4)],
]) test(`zero steer on ${name}`, () => { const p = ready(); change(p); assert.equal(p.intent(5), null); assert.equal(p.calls, 0); });

test('arm timeout and wrong-turn item cannot create eligibility', () => {
  const p = make(); p.event(ev('item/started', { id: 'wait', type: 'commandExecution', command: 'sleep 25', status: 'inProgress' }, 'old'), 2);
  assert.equal(p.intent(180001), null); assert.equal(p.calls, 0);
});
test('post-send disconnect or lost ack never replays', () => {
  for (const reason of ['disconnect', 'rpc_timeout']) { const p = ready(); p.intent(4); p.stop(reason); assert.equal(p.intent(5), null); assert.equal(p.calls, 1); assert.equal(p.result().result, 'unknown'); }
});
test('history text cannot substitute for identity or same turn; duplicates rejected', () => {
  const p = ready(); p.intent(4);
  assert.equal(p.history([{ id: 'new', items: [{ id: 'text-only', type: 'userMessage', content: [{ type: 'text', text: p.append }] }] }]), false);
  const item = { id: 'native', type: 'userMessage', clientId: p.clientId };
  assert.equal(p.history([{ id: 'other', items: [item] }]), false);
  assert.equal(p.history([{ id: 'new', items: [item, item] }]), false);
});
class FakeSocket extends EventEmitter {
  sent = []; closed = false;
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
}
test('RPC allowlist forbids starts, interrupts, other chats and resume overrides', () => {
  const s = new FakeSocket(), r = new Rpc(s, () => {}, () => {});
  for (const method of ['turn/start', 'thread/start', 'turn/interrupt', 'thread/list', 'thread/subscribe']) assert.throws(() => r.request(method, { threadId: THREAD }), /forbidden_method/);
  assert.throws(() => r.request('thread/read', { threadId: 'other' }), /wrong_thread/);
  assert.throws(() => r.request('thread/resume', { threadId: THREAD, excludeTurns: true, model: 'override' }), /unsafe_resume/);
  assert.equal(s.sent.length, 0); r.close();
});
test('RPC clears timers on response, ignores duplicate ack, passes approval without answering', async () => {
  const s = new FakeSocket(), events = [], r = new Rpc(s, m => events.push(m), () => {});
  const q = r.request('thread/read', { threadId: THREAD });
  s.emit('message', Buffer.from(JSON.stringify({ id: 1, result: { thread: { id: THREAD } } })));
  await q; assert.equal(r.pending.size, 0);
  s.emit('message', Buffer.from(JSON.stringify({ id: 1, result: {} })));
  s.emit('message', Buffer.from(JSON.stringify({ id: 9, method: 'approval', params: { threadId: THREAD } })));
  assert.equal(events.length, 1); assert.equal(s.sent.length, 1); r.close();
});
for (const [name, trigger] of [
  ['invalid JSON', s => s.emit('message', Buffer.from('{'))],
  ['oversize', s => s.emit('message', Buffer.alloc(1024 * 1024 + 1))],
  ['disconnect', s => s.emit('close')],
]) test(`RPC ${name} rejects pending and clears timers`, async () => {
  const s = new FakeSocket(), faults = [], r = new Rpc(s, () => {}, e => faults.push(e));
  const q = r.request('thread/read', { threadId: THREAD }); const rejected = assert.rejects(q); trigger(s); await rejected;
  assert.equal(r.pending.size, 0); assert.equal(faults.length, 1); assert.equal(s.closed, true);
});
test('RPC timeout removes pending without retry', async () => {
  const s = new FakeSocket(), r = new Rpc(s, () => {}, () => {}, 5);
  await assert.rejects(r.request('turn/steer', { threadId: THREAD }), /rpc_timeout/);
  assert.equal(s.sent.length, 1); assert.equal(r.pending.size, 0); r.close();
});
test('partial answer never satisfies final marker verification', () => {
  const p = ready(); p.event(ev('item/completed', { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: `${p.base} ${p.append}` }), 4);
  assert.equal([...p.turns.values()][0].final, false);
});
test('last final answer must contain both markers', () => {
  const p = ready();
  p.event(ev('item/completed', { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: `${p.base} ${p.append}` }), 4);
  p.event(ev('item/completed', { id: 'final-2', type: 'agentMessage', phase: 'final_answer', text: 'missing' }), 5);
  assert.equal([...p.turns.values()][0].final, false);
});
test('same turn ack without unique history clientId remains unknown', () => {
  const p = ready(); p.intent(4); p.receipt({ turnId: 'new' }); p.history([{ id: 'new', items: [] }]);
  assert.equal(p.result().result, 'unknown');
});
test('exact known shell wrappers accepted, added shell commands rejected', () => {
  const p = make(); start(p); user(p); command(p, { command: '/bin/zsh -lc "sleep 25"' }); assert.ok(p.intent(4));
  const bad = make(); start(bad); user(bad); command(bad, { command: '/bin/zsh -lc "sleep 25; ls"' }); assert.equal(bad.intent(4), null);
});
test('listener ownership handles socket symlink and detects retargeted epoch without real daemon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-fake-'));
  const socket = path.join(dir, 'native.sock'), link = path.join(dir, 'control.sock'), executable = path.join(dir, 'fake-native');
  const server = net.createServer();
  try {
    await new Promise(r => server.listen(socket, r)); fs.symlinkSync(socket, link); fs.writeFileSync(executable, 'fixture');
    const canonical = fs.realpathSync(socket), txt = fs.realpathSync(executable);
    assert.equal(listenerEpoch(link, '123', [`n${canonical}`], [`n${txt}`], executable), listenerEpoch(socket, '123', [`n${canonical}`], [`n${txt}`], executable));
    assert.throws(() => listenerEpoch(link, '123', ['n/other'], [`n${txt}`], executable), /listener_owner_mismatch/);
    fs.unlinkSync(link); fs.symlinkSync(executable, link);
    assert.throws(() => listenerEpoch(link, '123', [`n${canonical}`], [`n${txt}`], executable), /listener_owner_mismatch/);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('CLI observation budget defaults to ten minutes and strictly bounds overrides', () => {
  assert.equal(parseObserveMs(), 600000);
  assert.equal(parseObserveMs('1000'), 1000); assert.equal(parseObserveMs('600000'), 600000);
  for (const invalid of ['600001', '999', '-1', '1.5', 'NaN', 'Infinity', '1e5', '', '1000ms']) assert.throws(() => parseObserveMs(invalid), /invalid_observe_ms/);
  assert.equal(new Probe({ now: 0 }).observeMs, 600000);
});
test('injected small observation budget keeps exact deadline and never enables late steer', () => {
  const p = new Probe({ runId: 'tiny', now: 0, armMs: 10, observeMs: 5 });
  start(p); user(p); command(p); assert.equal(p.deadline, 6);
  p.event({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'new', status: 'inProgress' } } }, 4);
  assert.equal(p.deadline, 6); // Repeated started cannot renew this run's observation window.
  assert.equal(p.intent(6), null); assert.equal(p.calls, 0);
});
test('default budget allows delayed thinking but retains all one-steer gates', () => {
  const p = make(); start(p); user(p);
  p.event(ev('item/started', { id: 'wait', type: 'commandExecution', command: 'sleep 25', status: 'inProgress' }), 150000);
  assert.ok(p.intent(150001)); assert.equal(p.intent(150002), null); assert.equal(p.calls, 1);
});
test('event evidence is fixed-thread, bounded and omits content command and parameters', () => {
  const p = make();
  p.event(ev('item/started', { id: 'foreign', type: 'agentMessage', text: 'secret' }, 'foreign', 'other'), 1);
  assert.equal(p.evidence.length, 0);
  for (let n = 0; n < 2005; n++) p.event(ev('item/started', { id: 'item', type: 'userMessage', content: [{ type: 'text', text: 'secret-body' }], command: 'secret-command', text: 'secret-text' }, 'unseen'), n + 1);
  assert.equal(p.evidence.length, 2000); assert.equal(p.droppedEvents, 5);
  const saved = JSON.stringify(p.evidence); assert.equal(saved.includes('secret'), false); assert.equal(saved.includes('params'), false);
  assert.deepEqual(Object.keys(p.evidence[0]), ['ms', 'method', 'threadId', 'turnId', 'itemType', 'itemId', 'status']);
  assert.equal(p.evidence[0].method, 'item/started');
});
const snapshot = p => ({ id: 'new', status: 'inProgress', items: [
  { id: 'base', type: 'userMessage', content: [{ type: 'text', text: p.base }] },
  { id: 'wait', type: 'commandExecution', command: 'sleep 25', status: 'inProgress' },
] });
test('real native shape with no stored command uses live started/unended wait and steers once', () => {
  const p = ready(), pending = snapshot(p); pending.items.pop();
  assert.equal(p.preflight([pending], 4), 'ready'); assert.equal(p.reason, null); assert.equal(p.calls, 0);
  assert.equal(p.preflightChecks[0].commandCount, 0); assert.equal(p.preflightChecks[0].baseCount, 1);
  assert.equal(p.preflightChecks[0].toolSource, 'native_live_event'); assert.ok(p.intent(5)); assert.equal(p.intent(6), null);
});
test('persisted base marker retry remains bounded and never sends if marker absent', () => {
  const p = ready(), pending = snapshot(p); pending.items.shift();
  for (let n = 0; n < 7; n++) assert.equal(p.preflight([pending], 4 + n * 500), 'retry');
  assert.equal(p.preflight([pending], 3504), 'stop'); assert.equal(p.reason, 'history_not_hydrated_after_bounded_retry'); assert.equal(p.intent(3505), null); assert.equal(p.calls, 0);
});
test('live completion or approval during history retry prevents steer after history hydrates', () => {
  for (const stop of [p => command(p, { status: 'completed', exitCode: 0 }, 'item/completed'), p => p.stop('approval')]) {
    const p = ready(), pending = snapshot(p); pending.items.shift(); p.preflight([pending], 4); stop(p);
    assert.equal(p.preflight([snapshot(p)], 505), 'stop'); assert.equal(p.intent(506), null); assert.equal(p.calls, 0);
  }
});
test('history command conflicts, ended command and multiple candidates never retry or send', () => {
  for (const change of [t => { t.items[1].id = 'different'; }, t => { t.items[1].command = 'sleep 25; ls'; }, t => { t.items[1].status = 'completed'; }, t => t.items.push({ id: 'extra', type: 'commandExecution', command: 'sleep 25' })]) {
    const p = ready(), t = snapshot(p); change(t); assert.equal(p.preflight([t], 4), 'stop'); assert.equal(p.intent(5), null); assert.equal(p.calls, 0);
  }
  const p = ready(); assert.equal(p.preflight([snapshot(p), { id: 'another', status: 'inProgress', items: [] }], 4), 'stop'); assert.equal(p.calls, 0);
});
test('preflight details omit command/content/text and bound item types', () => {
  const p = ready(), pending = snapshot(p); pending.items[0].content[0].text += ' SECRET_CONTENT';
  p.preflight([pending], 4);
  const evidence = JSON.stringify(p.preflightChecks); assert.equal(evidence.includes('SECRET_CONTENT'), false); assert.equal(evidence.includes('sleep 25'), false);
  assert.equal(p.preflightChecks[0].commandIdMatch, true); assert.equal(p.preflightChecks[0].commandMatch, true); assert.equal(p.preflightChecks[0].decision, 'ready');
});
test('non-string notification method does not throw in evidence recorder', () => {
  const p = make(); assert.doesNotThrow(() => p.event({ method: 3, params: { threadId: THREAD } }, 1)); assert.equal(p.evidence[0].method, undefined); assert.equal(p.calls, 0);
});
test('zero stored commands cannot bypass disconnect approval ended epoch new-turn or deadline gates', () => {
  for (const stop of [
    p => p.stop('disconnect'),
    p => p.event({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } }, 4),
    p => command(p, { status: 'completed', exitCode: 0 }, 'item/completed'),
    p => p.stop('epoch_changed'),
    p => start(p, 'second'),
    p => { p.deadline = 4; },
  ]) {
    const p = ready(), page = snapshot(p); page.items.pop(); stop(p);
    assert.equal(p.preflight([page], 5), 'stop'); assert.equal(p.intent(6), null); assert.equal(p.calls, 0);
  }
  const p = make(); start(p); user(p); const page = snapshot(p); page.items.pop();
  assert.equal(p.preflight([page], 4), 'stop'); assert.equal(p.intent(5), null); // Saved data cannot create a live started event.
});
test('completion history still requires the completed command even when live gate accepted stored zero', () => {
  const p = ready(), page = snapshot(p); page.items.pop(); assert.equal(p.preflight([page], 4), 'ready'); p.intent(5); p.receipt({ turnId: 'new' });
  command(p, { status: 'completed', exitCode: 0 }, 'item/completed');
  p.event(ev('item/completed', { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `${p.base} ${p.append}` }), 6);
  p.event({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'new', status: 'completed' } } }, 7);
  p.history([{ id: 'new', status: 'completed', items: [...page.items, { id: 'append', type: 'userMessage', clientId: p.clientId }, { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `${p.base} ${p.append}` }] }]);
  assert.equal(p.historyVerified, false); assert.notEqual(p.result().result, 'pass');
});

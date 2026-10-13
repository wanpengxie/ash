import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl, ControlOutbox } from '../js/desktop-control.js';
const work = { node_id: 'node', endpoint_id: 'endpoint', kind: 'conversation', native_id: 'thread' };
const revision = 'a'.repeat(64);
function state(action, phase) {
  return { auth_scope: 'scope', target: { endpoint_id: 'endpoint', work }, authorization_revision: revision,
    connector_epoch: `epoch-${action}`, native_interface_version: 'v1', allowed_actions: ['send_input', 'steer'],
    snapshot: { work, state: phase, source: 'codex.live', revision: 1, connector_epoch: `epoch-${action}`,
      observed_at: phase === 'unknown' ? null : '2026-10-11T00:00:00Z', identity_provenance: phase === 'active' ? 'observed_turn_started' : 'none', ...(phase === 'active' ? { turn_id: 'turn-fresh' } : {}) },
    limitations: { atomic_idle_start: false, cancel: false, queue: false, runtime_state: 'observed', subscription_state: 'observed' } };
}
function fixture(phases, rejection = false) {
  const c = Object.create(DesktopControl.prototype), calls = []; let ids = 0;
  Object.assign(c, { doc: { hidden: false }, target: { device_id: 'device:endpoint', endpoint_id: 'endpoint', authorization_revision: revision, actions: ['send_input', 'steer'] }, work,
    scope: 'scope', visible: true, epoch: 0, busy: false, draft: '保留的原文', now: () => 100, id: () => `id-${++ids}`, render() {}, pollMs: 100000,
    net: { currentScope: 'scope', connectionId: 'connectionId', async collaborationControl(op, input) {
      calls.push({ op, input });
      if (op === 'state') return state(input.action, phases.shift() ?? 'unknown');
      if (op === 'query') return { fact: null };
      const r = input.request;
      return { fact: { request_id: r.request_id, operation_id: r.operation_id, work: r.work, action: r.action, expires_at: r.expires_at,
        expected_turn_id: r.expected_turn_id ?? null, delivery_status: rejection ? 'rejected' : 'unknown', attempt_id: null, connector_epoch: null,
        native_client_message_id: null, native_interface_version: null, receipt: null, reconciliation: null, error_code: rejection ? 'stale_precondition' : null, observed_at: 100 } };
    } } });
  c.outbox = new ControlOutbox({ storage: null, now: c.now }); c.outbox.bind('scope');
  c.state = state('send_input', 'idle'); c.stateAction = 'send_input';
  return { c, calls, idCount: () => ids };
}
test('submit refreshes cached idle and sends steer with the fresh turn and action lease', async () => {
  const { c, calls } = fixture(['active', 'active']);
  try {
    await c.submit();
    assert.deepEqual(calls.map(x => [x.op, x.input.action ?? x.input.request.action]), [['state', 'send_input'], ['state', 'steer'], ['apply', 'steer']]);
    assert.equal(calls[2].input.request.expected_turn_id, 'turn-fresh'); assert.equal(calls[2].input.expected_connector_epoch, 'epoch-steer');
    await c.refresh(); assert.equal(calls.filter(x => x.op === 'apply').length, 1);
  } finally { c.stop(); }
});
test('submit refreshes cached active and sends idle input without an old turn', async () => {
  const { c, calls } = fixture(['idle']); c.state = state('steer', 'active'); c.stateAction = 'steer';
  try { await c.submit(); const apply = calls.find(x => x.op === 'apply').input; assert.equal(apply.request.action, 'send_input'); assert.equal(apply.expected_connector_epoch, 'epoch-send_input'); assert.equal(Object.hasOwn(apply.request, 'expected_turn_id'), false); }
  finally { c.stop(); }
});
test('unknown and changing action observations preserve draft without allocating operations', async () => {
  for (const phases of [['unknown'], ['active', 'idle']]) {
    const { c, calls, idCount } = fixture(phases);
    try { await c.submit(); assert.equal(c.draft, '保留的原文'); assert.equal(idCount(), 0); assert.equal(c.outbox.items.length, 0); assert.equal(calls.some(x => x.op === 'apply'), false); assert.match(c.notice, /原文已保留/); }
    finally { c.stop(); }
  }
});
test('scope change while checking state fences submission and does not create an operation', async () => {
  const { c, calls, idCount } = fixture(['idle']); const original = c.net.collaborationControl;
  c.net.collaborationControl = async (...args) => { const result = await original(...args); c.net.currentScope = 'other'; c.cancel(); return result; };
  await c.submit(); assert.equal(calls.length, 1); assert.equal(idCount(), 0); assert.equal(c.outbox.items.length, 0); c.stop();
});
test('stale rejection restores text and only an explicit later submit creates a new operation', async () => {
  const { c, calls } = fixture(['idle', 'idle'], true);
  try { await c.submit(); assert.equal(c.draft, '保留的原文'); assert.match(c.notice, /状态已变化/); assert.equal(c.outbox.items[0].status, 'rejected'); assert.equal(calls.filter(x => x.op === 'apply').length, 1);
    await c.submit(); assert.equal(calls.filter(x => x.op === 'apply').length, 2); assert.notEqual(c.outbox.items[0].request.operation_id, c.outbox.items[1].request.operation_id);
  } finally { c.stop(); }
});

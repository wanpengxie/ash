import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlOutbox, controlKey, mappedMessage } from '../js/desktop-control.js';
const target = { version: 1, device_id: 'device:one', endpoint_id: 'one', grant_state: 'ready', authorization_revision: 'a'.repeat(64), actions: ['send_input'], capabilities: ['state', 'apply', 'query', 'reconcile'] };
const work = { node_id: 'one', endpoint_id: 'one', kind: 'conversation', native_id: 'thread' };
const item = (id, created, text = '正文') => ({ key: controlKey(target), created, status: 'unknown', request: { request_id: `req-${id}`, operation_id: `op-${id}`, work, action: 'send_input', input: { text }, expires_at: created + 86400000 } });
const storage = () => { const saved = new Map(); return { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }; };
test('outbox is bounded by scope, endpoint, grant revision, count, bytes and expiry', () => {
  let now = 100; const backend = storage(), outbox = new ControlOutbox({ storage: backend, endpoint: 'endpoint-one', now: () => now }); outbox.bind('scope-one');
  for (let i = 0; i < 33; i++) outbox.add(item(i, now));
  assert.equal(outbox.items.length, 32); assert.equal(outbox.items[0].request.operation_id, 'op-1');
  outbox.add(item(34, now, '字'.repeat(80000))); assert.ok(new TextEncoder().encode(JSON.stringify(outbox.items)).length <= 256 * 1024);
  const reload = new ControlOutbox({ storage: backend, endpoint: 'endpoint-one', now: () => now }); reload.bind('scope-one'); assert.ok(reload.items.length);
  reload.reconcile([{ ...target, authorization_revision: 'b'.repeat(64) }]); assert.equal(reload.items.length, 0);
  outbox.add(item(35, now)); now += 86400001; outbox.save(); assert.equal(outbox.items.length, 0);
  outbox.add(item(36, now)); outbox.bind('scope-two'); assert.equal(outbox.items.length, 0); assert.ok(!backend.getItem('ash.desktop.control-outbox.v1').includes('正文'));
  outbox.add(item(37, now)); const other = new ControlOutbox({ storage: backend, endpoint: 'endpoint-two', now: () => now }); other.bind('scope-two'); assert.equal(other.items.length, 0);
});
test('stable client identity joins same work user message, never assistant or equal text', () => {
  const pending = { ...item(1, 1), fact: { delivery_status: 'accepted', native_client_message_id: 'stable-client', receipt: { accepted_by: 'native', correlation: 'uncertain' } } };
  assert.equal(mappedMessage(pending, { work, role: 'user', source_client_message_id: 'stable-client' }), true);
  assert.equal(mappedMessage(pending, { work: { ...work, endpoint_id: 'other' }, role: 'user', source_client_message_id: 'stable-client' }), false);
  assert.equal(mappedMessage(pending, { work, role: 'assistant', source_client_message_id: 'stable-client' }), false);
  assert.equal(mappedMessage(pending, { work, role: 'user', text: '正文' }), false);
});

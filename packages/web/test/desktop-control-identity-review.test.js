import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlOutbox, controlKey } from '../js/desktop-control.js';
import { parseControlWork } from '../../device/src/collaboration/control-protocol.ts';

test('control outbox preserves and recovers gateway identities accepted by the wire parser', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const target = { endpoint_id: '-endpoint', device_id: 'device:-endpoint', authorization_revision: 'a'.repeat(64) };
  const work = { node_id: '_gateway-owner', endpoint_id: '-endpoint', kind: 'conversation', native_id: 'thread-1' };
  assert.deepEqual(parseControlWork(work), work);
  const item = { key: controlKey(target), created: 100, status: 'unknown', request: {
    request_id: 'request-1', operation_id: 'operation-1', work, action: 'send_input', input: { text: 'Continue' }, expires_at: 10000,
  } };
  const outbox = new ControlOutbox({ storage, endpoint: 'local', now: () => 100 });
  outbox.bind('scope'); outbox.add(item);
  const reopened = new ControlOutbox({ storage, endpoint: 'local', now: () => 101 });
  reopened.bind('scope');
  assert.deepEqual(reopened.list(target, work)[0].request, item.request);
  const invalidNative = { ...work, native_id: '_native' };
  assert.throws(() => parseControlWork(invalidNative));
  assert.throws(() => reopened.add({ ...item, request: { ...item.request, work: invalidNative } }));
  assert.throws(() => reopened.add({ ...item, request: { ...item.request, operation_id: '_operation' } }));
});

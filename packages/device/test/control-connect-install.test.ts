import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installControlConnection } from '../src/setup/control-connect-install';
import type { ControlConnectInstallOptions } from '../src/setup/control-connect-install';

const initial = { ownerId: 'owner', revision: 'revision', epoch: 'epoch' };
function fixture(mode: 'missing' | 'existing' | 'unknown' | 'changed' | 'daemon' | 'bad-preview' | 'invalid' = 'missing') {
  const root = realpathSync(mkdtempSync('/tmp/ash-control-install-')), project = join(root, 'project'); mkdirSync(project);
  const candidate = { version: 1 as const, endpoint_id: 'node', socket: '/isolated/control.sock', executable: '/isolated/codex', supportedVersions: ['0.134.0'] };
  const path = join(root, 'collaboration-control-runtime.json');
  if (mode === 'existing') writeFileSync(path, JSON.stringify(candidate), { mode: 0o600 });
  if (mode === 'invalid') writeFileSync(path, '{}', { mode: 0o600 });
  const events: string[] = []; let statuses = 0, confirmations = 0;
  const testing: NonNullable<ControlConnectInstallOptions['testing']> = {
    discover: () => { events.push('discover'); return candidate; },
    setupCall: (async (_state: string, _endpoint: string, operation: string) => {
      events.push(operation); assert.equal(operation, 'setup.status', 'configuration never writes a control grant');
      if (mode === 'daemon') throw Error('Material setup: service_unavailable');
      statuses++; return { precondition: mode === 'changed' && statuses > 1 ? { ...initial, epoch: 'changed' } : initial };
    }) as unknown as NonNullable<ControlConnectInstallOptions['testing']>['setupCall'],
    runtimeCall: async (_state, _endpoint, operation, body: any) => {
      events.push(operation);
      if (operation === 'control-runtime.prepare') { assert.deepEqual(body.candidate, candidate); return { owner_id: mode === 'bad-preview' ? 'other-owner' : initial.ownerId, configuration: candidate, preview_id: 'preview', selection_hash: 'hash' }; }
      assert.equal(operation, 'control-runtime.apply'); assert.deepEqual(body, { preview_id: 'preview', selection_hash: 'hash' });
      if (mode === 'unknown') throw Error('Material setup: result_unknown');
      return { state: 'saved', needsControlGrant: true };
    },
    select: async options => { events.push('select'); assert.equal(options.project, project); assert.equal(confirmations, 0, 'runtime config does not request a grant'); return { state: 'cancelled' }; },
  };
  return { root, events, path, testing, run: () => installControlConnection({ stateDir: root, endpointId: 'node', project, testing, choose: async () => null, confirm: async () => { confirmations++; return false; } }), close: () => rmSync(root, { recursive: true, force: true }) };
}
test('default discovery installs configuration once, without granting scope, before numbered selection', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.run(), { state: 'cancelled', runtime: 'saved' });
    assert.deepEqual(f.events, ['setup.status', 'discover', 'control-runtime.prepare', 'setup.status', 'control-runtime.apply', 'select']);
  } finally { f.close(); }
});
test('an existing protected runtime is preserved without discovery or repeat writes', async () => {
  const f = fixture('existing'); const before = readFileSync(f.path, 'utf8');
  try { assert.deepEqual(await f.run(), { state: 'cancelled', runtime: 'existing' }); assert.deepEqual(f.events, ['setup.status', 'select']); assert.equal(readFileSync(f.path, 'utf8'), before); }
  finally { f.close(); }
});
test('missing connection helper supplies the concrete run command and does not discover or save', async () => {
  const f = fixture('daemon');
  try { await assert.rejects(f.run(), /helper is not running.*ash-device run/); assert.deepEqual(f.events, ['setup.status']); }
  finally { f.close(); }
});
test('unknown save never retries or lists, and says configuration state may have changed without a grant', async () => {
  const f = fixture('unknown');
  try { await assert.rejects(f.run(), /final state is unknown.*No control grant was attempted/); assert.equal(f.events.filter(x => x === 'control-runtime.apply').length, 1); assert(!f.events.includes('select')); }
  finally { f.close(); }
});
test('pairing epoch changes after preview prevent the configuration write', async () => {
  const f = fixture('changed');
  try { await assert.rejects(f.run(), /Pairing, scope or project changed/); assert(!f.events.includes('control-runtime.apply')); assert(!f.events.includes('select')); }
  finally { f.close(); }
});
test('a preview for another owner is rejected without writing configuration', async () => {
  const f = fixture('bad-preview');
  try { await assert.rejects(f.run(), /preview changed/); assert(!f.events.includes('control-runtime.apply')); assert(!f.events.includes('select')); }
  finally { f.close(); }
});
test('invalid existing configuration fails closed rather than replacing it with a default', async () => {
  const f = fixture('invalid');
  try { await assert.rejects(f.run()); assert.deepEqual(f.events, ['setup.status']); assert.equal(readFileSync(f.path, 'utf8'), '{}'); }
  finally { f.close(); }
});

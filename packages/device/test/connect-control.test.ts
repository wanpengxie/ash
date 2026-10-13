import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceKey } from 'ash-gateway/client/client';
import { connectControl, type ControlTargetVerification } from '../src/setup/connect-control';
import type { callConnectionSetup } from '../src/setup/material-ipc';

const work = { node_id: 'node', endpoint_id: 'node', kind: 'conversation' as const, native_id: 'original-thread' };
const initial = { ownerId: 'paired-owner', revision: 'revision', epoch: 'epoch' };
function fixture(options: { changedPairing?: 'ownerId' | 'revision' | 'epoch'; changedTarget?: boolean; unknown?: boolean; expectedOwnerId?: string; expectedCwd?: string } = {}) {
  let statuses = 0, captures = 0, releases = 0, checks = 0, confirms = 0;
  const mutations: string[] = [], selections: unknown[] = [];
  const setupCall = (async (_state: string, _endpoint: string, operation: string, body: any) => {
    if (operation === 'setup.status') { statuses++; return { precondition: statuses > 1 && options.changedPairing ? { ...initial, [options.changedPairing]: 'changed' } : initial }; }
    if (operation === 'setup.prepare') { selections.push(body.selection); return { precondition: initial, preview_id: 'preview', selection_hash: 'hash', selection: body.selection }; }
    if (operation === 'setup.apply') {
      mutations.push(operation);
      if (options.unknown) throw Error('Material setup: result_unknown');
      return { control: { version: 1, owner_id: initial.ownerId, endpoint_id: 'node', authorization_generation: 1, allowed_actions: ['send_input', 'steer'], scope: { kind: 'single_work', work } } };
    }
    throw Error('Unexpected setup operation: ' + operation);
  }) as typeof callConnectionSetup;
  const targetVerification: ControlTargetVerification = { capture: async (requested, pairing) => {
    assert.deepEqual(requested, work); assert.equal(pairing.ownerId, initial.ownerId); captures++;
    let released = false;
    return { target: { work, cwd: '/original-project', ownerId: initial.ownerId, confirmation_binding: (options.changedTarget && captures > 1 ? 'b' : 'a').repeat(64) }, current: () => { assert(!released); checks++; return undefined; }, release: () => { assert(!released); released = true; releases++; return undefined; } };
  } };
  const run = (accept = true) => connectControl({ stateDir: 'isolated-no-files', endpointId: 'node', work, expectedOwnerId: options.expectedOwnerId, expectedCwd: options.expectedCwd, testing: { setupCall, targetVerification }, confirm: async summary => { confirms++; assert.equal(releases, 1, 'display proof released before user deliberation'); assert(summary.includes(work.native_id)); assert(summary.includes('Only this conversation')); return accept; } });
  return { run, mutations, selections, counts: () => ({ statuses, captures, releases, checks, confirms }) };
}

test('production rejects unavailable setup without confirmation or accepting caller target evidence', async () => {
  let prompted = false;
  await assert.rejects(connectControl({ stateDir: '/ash-control-unavailable-test', endpointId: 'node', work, confirm: async () => { prompted = true; return true; } }), /service_unavailable/);
  assert.equal(prompted, false);
});
test('the fixed native provider refuses a paired computer without shared owner runtime evidence', async () => {
  const root = mkdtempSync('/tmp/ash-control-no-provider-');
  let prompted = false, applied = false;
  try {
    const owner = await DeviceKey.generate();
    writeFileSync(join(root, 'paired.json'), JSON.stringify({ owner_key: owner.publicKey, grant_version: 1, permissions: [] }), { mode: 0o600 });
    const setupCall = (async (_state: string, _endpoint: string, operation: string) => {
      if (operation === 'setup.status') return { precondition: { ...initial, ownerId: owner.id } };
      applied = true; throw Error('No grant operation should be reached');
    }) as unknown as typeof callConnectionSetup;
    await assert.rejects(connectControl({ stateDir: root, endpointId: 'node', work, testing: { setupCall }, confirm: async () => { prompted = true; return true; } }), /original shared owner lookup.*unavailable/);
    assert.equal(prompted, false); assert.equal(applied, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('cancellation releases display evidence and never prepares or applies a grant', async () => {
  const f = fixture(); assert.equal((await f.run(false)).state, 'cancelled');
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.selections, []);
  assert.deepEqual(f.counts(), { statuses: 1, captures: 1, releases: 1, checks: 1, confirms: 1 });
});
test('a numbered selection stays bound to its discovery owner before prompting', async () => {
  const f = fixture({ expectedOwnerId: 'previous-owner' }); await assert.rejects(f.run(), /owner changed/);
  assert.equal(f.counts().captures, 0); assert.equal(f.counts().confirms, 0); assert.deepEqual(f.mutations, []);
});
test('a conversation moved outside the selected project is rejected before prompting', async () => {
  const f = fixture({ expectedCwd: '/selected-project' }); await assert.rejects(f.run(), /another project/);
  assert.equal(f.counts().confirms, 0); assert.equal(f.counts().releases, 1); assert.deepEqual(f.mutations, []);
});
for (const field of ['ownerId', 'revision', 'epoch'] as const) test(`a changed pairing ${field} after confirmation prevents mutation`, async () => {
  const f = fixture({ changedPairing: field }); await assert.rejects(f.run(), /Pairing or scope changed/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.selections, []); assert.equal(f.counts().releases, 1);
});
test('a changed original owner target requires a new confirmation without applying a grant', async () => {
  const f = fixture({ changedTarget: true }); await assert.rejects(f.run(), /conversation changed/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.selections, []); assert.equal(f.counts().releases, 2);
});
test('an unknown write result describes potentially changed control permission', async () => {
  const f = fixture({ unknown: true }); await assert.rejects(f.run(), /save was attempted; its final state may have changed/);
  assert.deepEqual(f.mutations, ['setup.apply']); assert.equal(f.counts().releases, 2);
});
test('one confirmation saves exactly single_work send_input and steer, without invoking a model', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { state: 'authorized', work });
  assert.deepEqual(f.selections, [{ kind: 'control', allowedActions: ['send_input', 'steer'], scope: { kind: 'single_work', work } }]);
  assert.deepEqual(f.mutations, ['setup.apply']); assert.equal(f.counts().confirms, 1); assert.equal(f.counts().releases, 2);
});

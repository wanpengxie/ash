import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectControlCli } from '../src/setup/connect-control-cli';
import type { connectControl } from '../src/setup/connect-control';
import type { listLoadedControlWorks } from '../src/setup/control-runtime-settings';
import type { ControlRuntimeSettings } from '../src/setup/control-runtime-settings';
import { ConnectionSetupService } from '../src/setup/service';
import { MaterialSetupIpcServer } from '../src/setup/material-ipc';

function fixture() {
  const project = realpathSync(mkdtempSync('/tmp/ash-control-cli-'));
  const items = [1, 2].map(n => ({ work: { node_id: 'node', endpoint_id: 'node', kind: 'conversation' as const, native_id: `loaded-${n}` }, title: 'Same title', cwd: project, updated_at: null }));
  const listWorks = (async () => ({ owner_id: 'owner', items })) as typeof listLoadedControlWorks;
  return { project, items, listWorks, close: () => rmSync(project, { recursive: true, force: true }) };
}
test('numeric selection freezes the native work snapshot and asks one permission confirmation', async () => {
  const f = fixture(); let confirms = 0;
  try {
    const connect = (async options => {
      assert.equal(options.work.native_id, 'loaded-2');
      assert.equal(options.expectedOwnerId, 'owner'); assert.equal(options.expectedCwd, f.project);
      assert.equal(await options.confirm(`Conversation: loaded-2\nProject: ${f.project}`), true);
      return { state: 'authorized', work: options.work };
    }) as typeof connectControl;
    const result = await connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: f.listWorks, connect }, choose: async choices => {
      assert(Object.isFrozen(choices)); assert(Object.isFrozen(choices[1].work));
      f.items.reverse(); f.items[0].work.native_id = 'replacement';
      return 2;
    }, confirm: async summary => { confirms++; assert(summary.includes('Same title')); assert(!summary.includes('loaded-2')); return true; } });
    assert.equal(result.state, 'authorized'); assert.equal(confirms, 1);
  } finally { f.close(); }
});
test('selection cancellation never reaches authorization or permission confirmation', async () => {
  const f = fixture();
  try {
    const result = await connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: f.listWorks, connect: async () => { throw Error('must not authorize'); } }, choose: async () => null, confirm: async () => { throw Error('must not confirm'); } });
    assert.deepEqual(result, { state: 'cancelled' });
  } finally { f.close(); }
});
test('unavailable shared runtime gives an actionable requirement without selection, config writes or authorization', async () => {
  const f = fixture();
  try {
    await assert.rejects(connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: async () => { throw Error('runtime unavailable'); }, connect: async () => { throw Error('must not authorize'); } }, choose: async () => { throw Error('must not choose'); }, confirm: async () => { throw Error('must not confirm'); } }), /verified shared Codex connection is required/);
  } finally { f.close(); }
});
test('foreign endpoint or project discovery is rejected before selection', async () => {
  for (const mode of ['endpoint', 'project']) {
    const f = fixture();
    try {
      if (mode === 'endpoint') f.items[0].work.node_id = 'foreign'; else f.items[0].cwd = join(f.project, 'other');
      await assert.rejects(connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: f.listWorks }, choose: async () => { throw Error('must not choose'); }, confirm: async () => false }), /project and endpoint/);
    } finally { f.close(); }
  }
});
test('invalid or empty numeric choices never reach the authorization writer', async () => {
  for (const number of [0, 3, 1.5]) {
    const f = fixture();
    try {
      await assert.rejects(connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: f.listWorks, connect: async () => { throw Error('must not authorize'); } }, choose: async () => number, confirm: async () => false }), /conversation number/);
    } finally { f.close(); }
  }
});
test('permission cancellation from connectControl is returned without a success claim', async () => {
  const f = fixture(); let confirms = 0;
  try {
    const connect = (async options => { assert.equal(await options.confirm(`Conversation: loaded-1`), false); return { state: 'cancelled', work: options.work }; }) as typeof connectControl;
    assert.equal((await connectControlCli({ stateDir: 'isolated', endpointId: 'node', project: f.project, testing: { listWorks: f.listWorks, connect }, choose: async () => 1, confirm: async () => { confirms++; return false; } })).state, 'cancelled');
    assert.equal(confirms, 1);
  } finally { f.close(); }
});
test('production numbered discovery uses the protected same-writer IPC list instead of a new native observer', async () => {
  const f = fixture(); let lists = 0;
  const runtime = { listLoadedWorks: async (project: string, current: () => undefined) => { assert.equal(project, f.project); assert.equal(current(), undefined); lists++; return { owner_id: 'owner', items: f.items }; } };
  const service = new ConnectionSetupService({ stateDir: f.project, endpointId: 'node', controlRuntime: runtime as unknown as ControlRuntimeSettings });
  const server = await MaterialSetupIpcServer.open(f.project, 'node', service);
  try {
    const result = await connectControlCli({ stateDir: f.project, endpointId: 'node', project: f.project, choose: async choices => { assert.equal(choices.length, 2); return null; }, confirm: async () => { throw Error('must not confirm'); } });
    assert.deepEqual(result, { state: 'cancelled' }); assert.equal(lists, 1);
  } finally { await server.close(); service.close(); f.close(); }
});

import type { DeviceMaterialRelay } from '../collaboration/relay';
import { captureControlTarget } from '../collaboration/control-runtime';
import { captureSetupConnectionProof } from '../link';
import type { TrustedCallContext } from '../collaboration/authorization';
import type { createDeviceCollaboration } from '../collaboration/device';
import { ConnectionSetupService, type SetupRuntime } from './service';
import { SetupError } from './scope-settings';
import { ReadSourceSettings } from './read-source-settings';
import { ControlRuntimeSettings } from './control-runtime-settings';
import { SetupNativeVerification } from './native-verification';
import { SetupShellStatus } from './shell-status';
import { MaterialSetupIpcServer } from './material-ipc';

/** Local CLI permission setup remains independent of the link wire protocol. */
export async function openDeviceSetup(options: {
  stateDir: string; nodeId: string; collaboration: ReturnType<typeof createDeviceCollaboration>;
  material?: DeviceMaterialRelay;
  testing?: {sourceHome?: string; readSource?: Parameters<typeof import('../collaboration/read-source').captureProtectedReadSource>[0]['testing']; control?: import('../collaboration/control-runtime').DeviceControlRuntimeOptions['testing']};
  context(): TrustedCallContext; busy(): boolean; current(): undefined; changed(): void;
}) {
  let changing = false, closed = false, generation = 0;
  const current = (): undefined => { if (closed) throw new SetupError('unavailable'); return options.current(); };
  const runtime = (readOnly: boolean, materialOnly = false): SetupRuntime => ({ reserveChange: async () => {
    current(); if (changing || (!readOnly && options.busy()) || (readOnly && options.collaboration.readBusy)) throw new SetupError('busy');
    if (!readOnly && !materialOnly) {
      const a = options.collaboration.control.changeSafety(), b = options.collaboration.create.changeSafety();
      if (a.state !== 'safe' || b.state !== 'safe') throw new SetupError(a.state === 'busy' || b.state === 'busy' ? 'busy' : 'unavailable');
    }
    const connection = options.context(); changing = true; const epoch = ++generation; let released = false;
    return { assertCurrent: () => { current(); if (released || epoch !== generation || !changing || !connection.isCurrent()) throw new SetupError('stale'); return undefined; },
      release: () => { if (!released) { released = true; changing = false; generation++; if (!readOnly) { options.collaboration.invalidate(); options.material?.invalidate(); } options.changed(); } return undefined; } };
  } });
  const readRuntime = runtime(true), controlRuntime = runtime(false), materialRuntime = runtime(false, true);
  const source = new ReadSourceSettings({stateDir: options.stateDir, endpointId: options.nodeId, runtime: readRuntime, current, testing: {defaultHome: options.testing?.sourceHome, source: options.testing?.readSource}});
  const control = new ControlRuntimeSettings({stateDir: options.stateDir, endpointId: options.nodeId, runtime: controlRuntime, current});
  const verification = new SetupNativeVerification({stateDir: options.stateDir, nodeId: options.nodeId, endpointId: options.nodeId, current, testing: options.testing?.control, readTesting: options.testing?.readSource});
  const service = new ConnectionSetupService({stateDir: options.stateDir, nodeId: options.nodeId, endpointId: options.nodeId,
    verification, readSource: source, controlRuntime: control, runtime: controlRuntime, readRuntime, materialRuntime,
    materialProjectVerification: async (cwd, ownerId, check) => {
      const relay = options.material; if (!relay) return false;
      const transport = relay.transport(), peer = await transport.capture(); transport.current(peer); if (peer.peer_id !== ownerId) return false;
      const context: TrustedCallContext = {transportOwnerId: ownerId, isCurrent: () => {try {check(); transport.current(peer); return true;} catch {return false;}}};
      const manifest = options.collaboration.create.manifest(context); if (!manifest.authorization_revision) return false;
      const result = await options.collaboration.create.execute('projects', {version:1,node_id:options.nodeId,endpoint_id:options.nodeId,cwd,authorization_revision:manifest.authorization_revision}, context);
      check(); transport.current(peer); return 'projects' in result && result.complete === true && result.projects.some(project => project.cwd === cwd);
    },
    materialVerification: async grant => {
      const relay=options.material; if (!relay) return false;
      const transport=relay.transport(), peer=await transport.capture(); transport.current(peer);
      if(peer.peer_id!==grant.source_node_id||grant.target.node_id!==options.nodeId||grant.target.endpoint_id!==options.nodeId)return false;
      const revision=options.collaboration.control.manifest().authorization_revision;if(!revision)return false;
      const target=await captureControlTarget(options.collaboration.control,{transportOwnerId:peer.peer_id,isCurrent:()=>{try{transport.current(peer);current();return true;}catch{return false;}}},{work:grant.target,endpoint_id:options.nodeId,authorization_revision:revision,action:'send_input'},options.testing?.control?'testing':'production');
      try{transport.current(peer);return await target.check();}finally{target.release();}
    },
    shellStatus: new SetupShellStatus({stateDir: options.stateDir, verification, current, connection: () => captureSetupConnectionProof(options.context())}),
    connectionReady: () => { try { return !changing && options.context().isCurrent(); } catch { return false; } },
    verifyRead: async (project, check) => {
      const context = options.context(), manifest = options.collaboration.manifest(context).collaboration;
      const envelope = {version: 1, endpoint_id: options.nodeId, authorization_revision: manifest.authorization_revision, page: {limit: 1}};
      const list = await options.collaboration.call('collaboration.work.list', envelope, undefined, context); check();
      if (!list.ok) throw new SetupError('unavailable');
      const items = (list.data as {items: {cwd: string; work: unknown}[]}).items;
      if (!Array.isArray(items) || items.some(item => item.cwd !== project)) throw new SetupError('invalid');
      let messages = 0;
      if (items.length) { const read = await options.collaboration.call('collaboration.work.read', {...envelope, work: items[0].work}, undefined, context); check(); if (!read.ok) throw new SetupError('unavailable'); messages = (read.data as {items: {messages: unknown[]}[]}).items.reduce((count, turn) => count + turn.messages.length, 0); }
      if (!context.isCurrent()) throw new SetupError('stale');
      return {state: items.length ? 'readable' : 'empty', conversations: items.length, messages};
    },
  });
  let ipc: MaterialSetupIpcServer;
  try { ipc = await MaterialSetupIpcServer.open(options.stateDir, options.nodeId, service, {pending: () => options.collaboration.results.pending(), approve: (id, check) => options.collaboration.results.approve(id, check), revoke: () => options.collaboration.results.revoke()}); }
  catch (error) { await verification.close(); await source.close(); await control.close(); service.close(); throw error; }
  return {get changing() {return changing;}, async close() { closed = true; generation++; const result = await ipc.close(); if (result.state !== 'closed') throw new Error('Local setup is still draining'); await verification.close(); await source.close(); await control.close(); service.close(); }};
}

import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { controlRuntimePath, parseControlRuntimeConfig } from '../collaboration/control-runtime';
import { readLocalStateFile } from '../collaboration/local-state';
import { discoverDefaultControlRuntime } from './control-runtime-discovery';
import { callConnectionSetup, callControlRuntimeSetup } from './material-ipc';
import { connectControlCli } from './connect-control-cli';
import type { SetupPrecondition } from './scope-settings';

type SelectionOptions = Pick<Parameters<typeof connectControlCli>[0], 'choose' | 'confirm'>;
export interface ControlConnectInstallOptions extends SelectionOptions {
  stateDir: string; endpointId: string; project: string;
  testing?: {
    discover?: typeof discoverDefaultControlRuntime;
    setupCall?: typeof callConnectionSetup;
    runtimeCall?: typeof callControlRuntimeSetup;
    select?: typeof connectControlCli;
  };
}
function paired(value: SetupPrecondition | null | undefined): SetupPrecondition {
  if (!value || ['ownerId', 'revision', 'epoch'].some(key => typeof value[key as keyof SetupPrecondition] !== 'string' || !value[key as keyof SetupPrecondition])) throw Error('Pair this computer with Ash first.');
  return Object.freeze({ ownerId: value.ownerId, revision: value.revision, epoch: value.epoch });
}
/** Configure the fixed existing shared connection, then select a conversation.
 * Configuration itself creates no control grant and never starts an executor.
 * Production selection uses the protected same-writer IPC metadata list. */
export async function ensureControlConnection(options: Pick<ControlConnectInstallOptions,'stateDir'|'endpointId'|'project'|'testing'>): Promise<{ runtime: 'existing' | 'saved' }> {
  const project = realpathSync(options.project), directory = lstatSync(project, { bigint: true });
  if (!directory.isDirectory()) throw Error('Choose an existing project directory.');
  const setupCall = options.testing?.setupCall ?? callConnectionSetup;
  const runtimeCall = options.testing?.runtimeCall ?? callControlRuntimeSetup;
  let runtime: 'existing' | 'saved' = 'existing', attempted = false, stage = 'connection helper';
  try {
    const initial = paired((await setupCall(options.stateDir, options.endpointId, 'setup.status', {})).precondition);
    stage = 'shared connection configuration';
    const existing = readLocalStateFile(controlRuntimePath(options.stateDir), 16 * 1024);
    if (existing) parseControlRuntimeConfig(JSON.parse(existing.raw), options.endpointId);
    else {
      stage = 'shared connection discovery';
      const candidate = (options.testing?.discover ?? discoverDefaultControlRuntime)(options.endpointId);
      stage = 'shared connection preview';
      const preview = await runtimeCall(options.stateDir, options.endpointId, 'control-runtime.prepare', { candidate });
      if (preview.owner_id !== initial.ownerId || !isDeepStrictEqual(parseControlRuntimeConfig(preview.configuration, options.endpointId), candidate) || typeof preview.preview_id !== 'string' || !preview.preview_id || typeof preview.selection_hash !== 'string' || !preview.selection_hash) throw Error('Shared connection preview changed; inspect the current connection before trying again.');
      stage = 'shared connection current';
      const fresh = paired((await setupCall(options.stateDir, options.endpointId, 'setup.status', {})).precondition);
      const currentDirectory = lstatSync(project, { bigint: true });
      if (!isDeepStrictEqual(initial, fresh) || realpathSync(options.project) !== project || !currentDirectory.isDirectory() || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) throw Error('Pairing, scope or project changed before saving the shared connection.');
      stage = 'shared connection save'; attempted = true;
      const result = await runtimeCall(options.stateDir, options.endpointId, 'control-runtime.apply', { preview_id: preview.preview_id, selection_hash: preview.selection_hash });
      if (result.state !== 'saved' || result.needsControlGrant !== true) throw Error('Shared connection save did not return a valid receipt.');
      runtime = 'saved';
    }
  } catch (error) {
    const advice = String(error).includes('service_unavailable')
      ? 'The paired Ash connection helper is not running. Start it with ash-device run, then run this connect command again.'
      : String(error);
    throw Error(`${stage}: ${advice}${attempted ? ' Shared connection save was attempted; its final state is unknown. No control grant was attempted. Inspect the current configuration before retrying; do not automatically resend this save.' : ''}`);
  }
  return {runtime};
}
export async function installControlConnection(options:ControlConnectInstallOptions):Promise<Awaited<ReturnType<typeof connectControlCli>> & {runtime:'existing'|'saved'}>{
  const {runtime}=await ensureControlConnection(options);
  const project=realpathSync(options.project);
  const selected = await (options.testing?.select ?? connectControlCli)({ stateDir: options.stateDir, endpointId: options.endpointId, project, choose: options.choose, confirm: options.confirm });
  return { ...selected, runtime };
}

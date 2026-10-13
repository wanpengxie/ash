import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { WorkRef } from '../collaboration/types';
import { parseControlAuthorization } from '../collaboration/control-authorization';
import { callConnectionSetup } from './material-ipc';
import type { SetupPrecondition } from './scope-settings';
import { captureLoadedControlWork, controlWorkProofTarget, currentLoadedControlWork, releaseLoadedControlWork } from './control-runtime-settings';

/** The native provider must attest an already loaded work at its original
 * shared owner. A history lookup alone is not sufficient evidence. */
export interface LoadedControlTarget {
  readonly work: WorkRef;
  readonly cwd: string;
  readonly ownerId: string;
  readonly confirmation_binding: string;
}
export interface LoadedControlTargetLease {
  readonly target: LoadedControlTarget;
  current(): undefined;
  release(): undefined;
}
export interface ControlTargetVerification {
  capture(work: Readonly<WorkRef>, pairing: Readonly<SetupPrecondition>): Promise<LoadedControlTargetLease>;
}
export interface ConnectControlOptions {
  stateDir: string;
  endpointId: string;
  work: WorkRef;
  /** A numbered native discovery selection remains bound to its original owner
   * and exact project when the authorization prompt is opened later. */
  expectedOwnerId?: string;
  expectedCwd?: string;
  confirm(summary: string): Promise<boolean>;
  /** Explicit isolated fixtures only; production always uses the fixed native
   * opaque proof provider rather than caller-supplied target evidence. */
  testing?: { setupCall?: typeof callConnectionSetup; targetVerification?: ControlTargetVerification };
}

function copyWork(work: WorkRef, endpointId: string): Readonly<WorkRef> {
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f]/.test(v);
  if (!work || Object.keys(work).length !== 4 || !['node_id', 'endpoint_id', 'kind', 'native_id'].every(k => Object.hasOwn(work, k)) || work.kind !== 'conversation' || work.node_id !== endpointId || work.endpoint_id !== endpointId || !id(work.node_id) || !id(work.native_id)) throw Error('Choose one conversation at this endpoint.');
  return Object.freeze({ node_id: work.node_id, endpoint_id: work.endpoint_id, kind: 'conversation', native_id: work.native_id });
}
function checkedTarget(lease: LoadedControlTargetLease, work: Readonly<WorkRef>, pairing: SetupPrecondition): LoadedControlTarget {
  if (lease.current() !== undefined) throw Error('Original shared owner evidence is unavailable.');
  const target = lease.target;
  if (!target || !isDeepStrictEqual(target.work, work) || target.ownerId !== pairing.ownerId || typeof target.cwd !== 'string' || !isAbsolute(target.cwd) || /[\u0000-\u001f]/.test(target.cwd) || !/^[a-f0-9]{64}$/.test(target.confirmation_binding)) throw Error('Original shared owner or conversation changed.');
  return Object.freeze({ work, cwd: target.cwd, ownerId: target.ownerId, confirmation_binding: target.confirmation_binding });
}
function checkedPairing(pairing: SetupPrecondition | null | undefined): SetupPrecondition {
  if (!pairing || ['ownerId', 'revision', 'epoch'].some(k => typeof pairing[k as keyof SetupPrecondition] !== 'string' || !pairing[k as keyof SetupPrecondition])) throw Error('Pair this computer with Ash first.');
  return Object.freeze({ ownerId: pairing.ownerId, revision: pairing.revision, epoch: pairing.epoch });
}

/** Grants only send_input and steer for one already loaded original-owner work.
 * This function never sends input, resumes a thread, or invokes a model. */
export async function connectControl(options: ConnectControlOptions): Promise<{ state: 'cancelled' | 'authorized'; work: Readonly<WorkRef> }> {
  const setupCall = options.testing?.setupCall ?? callConnectionSetup;
  const targetVerification: ControlTargetVerification = options.testing?.targetVerification ?? {
    capture: async work => {
      const proof = await captureLoadedControlWork({ stateDir: options.stateDir, endpointId: options.endpointId, work, current: () => undefined });
      try {
        const native = controlWorkProofTarget(proof);
        return { target: { work: native.work, cwd: native.cwd, ownerId: native.owner_id, confirmation_binding: native.confirmation_binding }, current: () => currentLoadedControlWork(proof), release: () => { releaseLoadedControlWork(proof); return undefined; } };
      } catch (error) { releaseLoadedControlWork(proof); throw error; }
    },
  };
  const work = copyWork(options.work, options.endpointId);
  let lease: LoadedControlTargetLease | undefined, attempted = false, stage = 'connection status';
  try {
    const initial = checkedPairing((await setupCall(options.stateDir, options.endpointId, 'setup.status', {})).precondition);
    if (options.expectedOwnerId !== undefined && initial.ownerId !== options.expectedOwnerId) throw Error('The selected conversation owner changed; choose again.');
    stage = 'original shared owner lookup';
    lease = await targetVerification.capture(work, initial);
    let display: LoadedControlTarget;
    try { display = checkedTarget(lease, work, initial); } finally { lease.release(); lease = undefined; }
    if (options.expectedCwd !== undefined && display.cwd !== options.expectedCwd) throw Error('The selected conversation moved to another project; choose again.');
    if (!await options.confirm(`Allow Ash to send input and steer this Codex conversation?\nConversation: ${work.native_id}\nProject: ${display.cwd}\nOnly this conversation is authorized. This replaces the previous control range. No input will be sent by this setup command.`)) return { state: 'cancelled', work };
    stage = 'confirmation current';
    const confirmed = checkedPairing((await setupCall(options.stateDir, options.endpointId, 'setup.status', {})).precondition);
    if (!isDeepStrictEqual(confirmed, initial)) throw Error('Pairing or scope changed; confirm again.');
    lease = await targetVerification.capture(work, confirmed);
    if (!isDeepStrictEqual(checkedTarget(lease, work, confirmed), display)) throw Error('Original shared owner or conversation changed; confirm again.');
    const selection = { kind: 'control' as const, allowedActions: ['send_input', 'steer'] as ('send_input' | 'steer')[], scope: { kind: 'single_work' as const, work } };
    stage = 'control scope preview';
    const preview = await setupCall(options.stateDir, options.endpointId, 'setup.prepare', { selection });
    if (!isDeepStrictEqual(preview.precondition, initial) || !isDeepStrictEqual(preview.selection, selection)) throw Error('Control scope changed; confirm again.');
    stage = 'control scope current';
    const fresh = checkedPairing((await setupCall(options.stateDir, options.endpointId, 'setup.status', {})).precondition);
    if (!isDeepStrictEqual(fresh, initial) || !isDeepStrictEqual(checkedTarget(lease, work, fresh), display)) throw Error('Pairing, scope or target changed; confirm again.');
    stage = 'control scope save'; attempted = true;
    const applied = await setupCall(options.stateDir, options.endpointId, 'setup.apply', { preview_id: preview.preview_id, selection_hash: preview.selection_hash });
    const grant = parseControlAuthorization(applied.control, options.endpointId);
    if (grant.owner_id !== initial.ownerId || !isDeepStrictEqual(grant.allowed_actions, ['send_input', 'steer']) || !isDeepStrictEqual(grant.scope, selection.scope) || grant.expires_at !== undefined) throw Error('Saved control scope differs from the confirmed conversation.');
    return { state: 'authorized', work };
  } catch (error) {
    throw Error(`${stage}: ${String(error)}${attempted ? ' Control permission save was attempted; its final state may have changed. Inspect the current scope before confirming again.' : ''}`);
  } finally { lease?.release(); }
}

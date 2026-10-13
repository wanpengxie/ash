import { lstatSync, realpathSync } from 'node:fs';
import type { WorkRef } from '../collaboration/types';
import { connectControl } from './connect-control';
import type { listLoadedControlWorks } from './control-runtime-settings';
import { callControlRuntimeSetup } from './material-ipc';

export interface ControlConversationChoice { readonly work: WorkRef; readonly title: string; readonly cwd: string; readonly updated_at: number | null }
const printable = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
/** Native loaded conversations only. Numeric selection is a UI choice; the
 * separate connectControl confirmation grants the exact selected work. */
export async function connectControlCli(options: {
  stateDir: string; endpointId: string; project: string;
  choose(items: readonly ControlConversationChoice[]): Promise<number | null>;
  confirm(summary: string): Promise<boolean>;
  testing?: { listWorks?: typeof listLoadedControlWorks; connect?: typeof connectControl };
}): Promise<{ state: 'cancelled' | 'authorized'; work?: Readonly<WorkRef> }> {
  const project = realpathSync(options.project), physical = lstatSync(project, { bigint: true });
  if (!physical.isDirectory()) throw Error('Choose an existing project directory.');
  let discovery: Awaited<ReturnType<typeof listLoadedControlWorks>>;
  try {
    discovery = options.testing?.listWorks
      ? await options.testing.listWorks({ stateDir: options.stateDir, endpointId: options.endpointId, project, current: () => undefined })
      : await callControlRuntimeSetup(options.stateDir, options.endpointId, 'control-runtime.list', { project });
  } catch (error) {
    throw Error(`A verified shared Codex connection is required. Connect the original Codex shared owner before granting control. ${String(error)}`);
  }
  const items = discovery.items.map(item => {
    const work = item.work;
    if (!work || Object.keys(work).length !== 4 || work.node_id !== options.endpointId || work.endpoint_id !== options.endpointId || work.kind !== 'conversation' || typeof work.native_id !== 'string' || !work.native_id || /[\u0000-\u001f]/.test(work.native_id) || typeof item.title !== 'string' || item.cwd !== project) throw Error('Loaded conversation discovery does not match this project and endpoint.');
    return Object.freeze({ work: Object.freeze({ ...work }), title: printable(item.title) || '未命名会话', cwd: project, updated_at: typeof item.updated_at === 'number' && Number.isFinite(item.updated_at) ? item.updated_at : null });
  });
  if (!items.length) throw Error('No loaded Codex conversations were found in this project. Open the conversation in the original shared Codex connection, then try again.');
  const number = await options.choose(Object.freeze(items));
  if (number === null) return { state: 'cancelled' };
  if (!Number.isSafeInteger(number) || number < 1 || number > items.length) throw Error('Choose a conversation number from the displayed list.');
  const selected = items[number - 1], fresh = lstatSync(project, { bigint: true });
  if (realpathSync(options.project) !== project || !fresh.isDirectory() || fresh.dev !== physical.dev || fresh.ino !== physical.ino) throw Error('The project changed; choose the conversation again.');
  return (options.testing?.connect ?? connectControl)({ stateDir: options.stateDir, endpointId: options.endpointId, work: selected.work, expectedOwnerId: discovery.owner_id, expectedCwd: project, confirm: summary => options.confirm(summary.replace(`Conversation: ${selected.work.native_id}`, `Conversation: ${selected.title}`)) });
}

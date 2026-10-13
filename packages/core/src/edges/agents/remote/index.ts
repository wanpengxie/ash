/**
 * Remote drivers (HUB-MODULES §2.5, SPEC-08 §1.2): Codex, Claude Code and WorkBuddy run on a computer, and the computer
 * program carries them to the hub over the `agent` channel (SPEC-03 §6). Here they are ordinary `AgentDriver`s.
 *
 * Assembly:
 * ```ts
 * const remote = createRemoteDrivers({ router, log });
 * linkServer.onChannel("agent", remote.attach);
 * createAgents({ ..., drivers: { dsh: ..., ...remote.factories } });
 * ```
 * Which computer an agent runs on is its declaration's `native.on`; a computer that is not connected (or does not offer
 * the runtime) makes `start` fail, and the agent is never moved to another body (SPEC-01 §11.1).
 */
import type { AgentDriverFactory } from "../../../../../sdk/src/driver";
import type { ChannelAttach } from "../../link-server";
import { RemoteDriver } from "./driver";
import { Directory, type RemoteOptions } from "./directory";

export interface RemoteDrivers {
  /** One driver factory per runtime kind, to go in the agents module's `drivers`. */
  factories: Record<string, AgentDriverFactory>;
  /** Mount with `linkServer.onChannel("agent", attach)`. */
  attach: ChannelAttach;
}

export function createRemoteDrivers(options: RemoteOptions): RemoteDrivers {
  const dir = new Directory(options);
  return {
    factories: Object.fromEntries(dir.kinds.map((kind): [string, AgentDriverFactory] => [kind, (report) => new RemoteDriver(dir, kind, report)])),
    attach: dir.attach,
  };
}

export type { AttachedPort, RemoteOptions } from "./directory";

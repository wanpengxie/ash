/**
 * The script agent (debug builds only): `agent:script`, an agent that does not think. The owner's command line sends it a script
 * (JSON) as a message, and it makes the tool calls the script lists through the same tool surface, token and turn a real agent
 * has, so the router, the gate, the approvals, the host and the status see an ordinary agent. See `script-agent.mjs`.
 *
 * It is the DSH driver started on another program: the same ACP, the same session and turn events. Nothing here exists in a build
 * whose host does not say `dev.script_agent` (host.json): no driver for the runtime kind `script`, so nobody can declare such an agent.
 */
import { dirname } from "node:path";
import type { AgentDriverFactory } from "../../../../sdk/src/driver";
import { createDshDriver, type DshDriverDeps } from "./dsh";
import type { Runs } from "./runs";
import { SCRIPT_AGENT_SOURCE } from "./script-agent.generated";

export const SCRIPT_AGENT_ID = "agent:script";
export const SCRIPT_RUNTIME = "script";
const PROGRAM = "script-agent.mjs";

/** The DSH driver of the main body, started on the script agent's program (written next to the agent's baseline file before each start). */
export function scriptDriver(deps: Pick<DshDriverDeps, "spawn" | "writeFile" | "runtimePath" | "readBlob" | "log">): AgentDriverFactory {
  return (report) => createDshDriver({
    ...deps, report, argv: ["node", PROGRAM],
    writeFile: async (path, content) => { await deps.writeFile(path, content); await deps.writeFile(`${dirname(path)}/${PROGRAM}`, SCRIPT_AGENT_SOURCE); },
  });
}

/**
 * The script agent is not declared by itself: the owner's command line declares it for a run and removes it after, so the owner's
 * screens never list it. At start (a debug hub only) one an earlier run or an older build left behind is forgotten.
 */
export function forgetScriptAgent(runs: Pick<Runs, "get" | "remove">): void {
  if (runs.get(SCRIPT_AGENT_ID)) runs.remove(SCRIPT_AGENT_ID);
}

/** What the command line declares for a run (`service:agents/declare`). */
export const SCRIPT_AGENT_DECL = {
  id: SCRIPT_AGENT_ID, name: "script", runtime: { kind: SCRIPT_RUNTIME },
  summary: "A debug agent that carries out the script it is sent.",
  brief: "You are the script agent of a debug build: a message to you is a script, and you do what it lists, step by step. You do not think or choose.",
};

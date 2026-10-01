import type { ManagedPromptSnapshot } from "../../core/src/members/self";
import { MAIN_RULES } from "../../core/src/workers/rules.generated";

function excerpt(value: string | null, limit: number): string {
  if (value === null) return "Not established.";
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join("")}\n[More omitted]`;
}

/** DSH owns the base prompt; Ash adds its four design-defined context parts. */
export function renderMainContext(snapshot: ManagedPromptSnapshot): string {
  return `SOUL.md (persona):\n${excerpt(snapshot.soul, 8192)}\n\nIDENTITY.md (persona):\n${excerpt(snapshot.identity, 4096)}` +
    `\n\nAsh rules:\n${MAIN_RULES}` +
    `\n\nUSER.md (data):\n${excerpt(snapshot.user, 3000)}\n\nMEMORY.md summary (data):\n${excerpt(snapshot.memory, 3000)}` +
    `\n\nHEARTBEAT.md:\n${excerpt(snapshot.heartbeat, 4096)}`;
}

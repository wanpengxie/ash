import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { detectRuntimes, type RuntimeInfo } from "./detect";
import { CodexSession } from "./codex";
import { ClaudeSession } from "./claude";
import { WorkBuddySession } from "./workbuddy";
import type { AgentSession } from "./types";

/** Discovery never sends a model task. Keep the last catalog while a refresh is in flight. */
export async function runtimeCatalog(stateDir: string, detect = detectRuntimes) {
  let items = await detect(), pending: Promise<void> | undefined, updated = 0, stopped = false;
  const probed = new Map<string, number>();
  const refresh = () => {
    if (stopped || pending || Date.now() - updated < 60_000) return;
    updated = Date.now();
    pending = (async () => {
      const next = await detect();
      await Promise.all(next.map(async info => {
        if (!info.installed || info.logged_in === false || stopped) return;
        const previous = items.find(item => item.kind === info.kind);
        info.models = previous?.models ?? [];
        // Reuse successful catalogs; rediscover after an install/login change.
        if (previous?.installed && previous.logged_in === info.logged_in && Date.now() - (probed.get(info.kind) ?? 0) < 15 * 60_000) return;
        probed.set(info.kind, Date.now());
        const cwd = join(stateDir, "runtime-probes", info.kind);
        await mkdir(cwd, { recursive: true });
        const Driver = { codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession }[info.kind];
        let session: AgentSession | undefined;
        try {
          session = await Driver.open({ cwd, tools: [], onEvent() {}, onModels: models => { info.models = models; }, onOutbound: async () => { throw new Error("Discovery does not run tools"); } });
        } catch { /* Failed discovery is unknown, not a made-up model catalog. */ }
        finally { await session?.close(); }
      }));
      if (!stopped) items = next;
    })().catch(() => {}).finally(() => { pending = undefined; });
  };
  // Test/injected runtimes already supply their catalog; do not launch local CLIs for them.
  if (detect === detectRuntimes) refresh();
  return { get: (): RuntimeInfo[] => { if (detect === detectRuntimes) refresh(); return items; }, close: async () => { stopped = true; await pending; } };
}

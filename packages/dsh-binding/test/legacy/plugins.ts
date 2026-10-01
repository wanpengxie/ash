// Plugins for ash's settings page, through DSH's own plugin manager service (the one DSH's UI
// uses): install from npm, a GitHub address or a local path; enable, disable, remove. The
// manager edits the profile and hot-reloads what it can; the rest needs a restart of the host
// process, which ash asks its host to do.

import type { DshHost } from "./host";

export interface PluginOps {
  list(): Promise<unknown>;
  op(body: Record<string, unknown>): Promise<unknown>;
}

export function dshPlugins(host: DshHost, restart: (() => Promise<void>) | null, log: (...a: unknown[]) => void): PluginOps {
  const pm = () => {
    const m = host.ctx?.get("pluginManager");
    if (!m) throw new Error("DSH's plugin manager is not available in this profile");
    return m;
  };
  const str = (v: unknown, name: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
    return v.trim();
  };
  return {
    async list() {
      const m = pm();
      const [bundles, plugins] = await Promise.all([m.listBundles(), m.listPlugins()]);
      return { bundles, plugins };
    },
    async op(b) {
      const m = pm();
      let r: { application?: string; changed?: boolean; error?: unknown } & Record<string, unknown>;
      switch (b.op) {
        case "install":
          r = await m.installBundle(str(b.spec, "spec"), { enabled: true });
          break;
        case "remove":
          r = await m.removeBundle(str(b.name, "name"));
          break;
        case "enable":
        case "disable":
          r = await m.setBundleEnabled(str(b.name, "name"), b.op === "enable");
          break;
        case "plugin":
          r = await m.setPluginEnabled(str(b.id, "id"), b.enabled === true);
          break;
        default:
          throw new Error(`unknown plugin op ${String(b.op)}`);
      }
      log(`plugins: ${b.op} ${b.spec ?? b.name ?? b.id} → ${r.application}${r.error ? ` (${JSON.stringify(r.error)})` : ""}`);
      // A restart is the host's job; answer first, then restart (the UI reconnects by itself).
      if (r.application === "restart-required" && restart) setTimeout(() => void restart().catch((e) => log("restart request failed:", e)), 500);
      return { ...r, restarting: r.application === "restart-required" && restart !== null };
    },
  };
}

// Model and credential settings for ash's settings page, through DSH's own services
// (llm catalog, agentDefaultModel, credentials) — the same documents DSH's UI would write,
// so a DSH home configured elsewhere keeps working here and vice versa.

import type { DshHost } from "./host";

const KNOWN_KEYS = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

export function dshSettings(host: DshHost) {
  const ctx = () => host.ctx;
  const credRef = async (name: string) => (await host.imp("@deepseek-ai/dsh-credentials")).credentialRef(name);
  return {
    async get(): Promise<unknown> {
      const c = ctx();
      const selection = c.get("agentDefaultModel")?.currentSelection?.();
      const llm = c.get("llm");
      const providers = (llm?.listProviders?.() ?? []) as { id?: string; name?: string; provider?: string }[];
      const models: { provider: string; id: string; name: string }[] = [];
      for (const p of providers) {
        const pid = String(p.id ?? p.provider ?? "");
        if (!pid) continue;
        try {
          for (const m of await llm.listModels(pid)) models.push({ provider: pid, id: m.id, name: m.name });
        } catch {
          /* a provider without catalog */
        }
      }
      const credentials: Record<string, boolean> = {};
      const cred = c.get("credentials");
      for (const k of KNOWN_KEYS) {
        try {
          credentials[k] = Boolean((await cred?.describe(await credRef(k)))?.configured);
        } catch {
          credentials[k] = false;
        }
      }
      // What this DSH world has loaded: installed plugin packages and the tools they registered.
      const tools = ((c.get("tools")?.schemas?.() ?? []) as { name: string }[]).map((t) => t.name).sort();
      return { dsh: host.version, model: selection ?? null, models, credentials, plugins: host.plugins(), tools };
    },
    async set(body: Record<string, unknown>): Promise<unknown> {
      const c = ctx();
      const creds = (body.credentials ?? {}) as Record<string, string>;
      for (const [name, value] of Object.entries(creds)) {
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error(`bad credential name ${name}`);
        const ref = await credRef(name);
        if (value) await c.get("credentials").set(ref, String(value));
        else await c.get("credentials").unset(ref);
      }
      const model = body.model as { provider?: string; model?: string } | undefined;
      if (model?.provider && model.model) await c.get("agentDefaultModel").saveSelection({ ...c.get("agentDefaultModel").currentSelection(), provider: model.provider, model: model.model });
      return this.get();
    },
  };
}

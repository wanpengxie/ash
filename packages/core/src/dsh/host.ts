// DSH host: ash boots DSH's *core* (profile "ash" = @deepseek-ai/dsh-base only, no web or
// other app surface) inside its own process, through DSH's public host entry
// (`@deepseek-ai/dsh/profile-boot`, the same one DSH's desktop app uses).
//
// Two handles cross between the worlds, both as direct in-process calls:
//   ① ash → DSH: the root context (agents, tools, system prompt, events)
//   ② DSH → ash: `ctx.ash`, provided by a thin door plugin; ash's system services are also
//      registered as native DSH tools, so every DSH agent can use them without MCP.
// DSH's own packages are never modified; ash only uses documented public seams.

import { randomUUID } from "node:crypto";
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AshWorld } from "./door";
import { ashTools } from "./door";

export interface DshHostOptions {
  /** Directory of the installed @deepseek-ai/dsh package. */
  root: string;
  /** DSH home used by ash's DSH world (credentials, settings, sessions). */
  home: string;
  /** Another DSH home to copy credentials/settings from on first start (e.g. an earlier install). */
  seedFrom?: string;
}

/** Minimal views of the DSH objects ash touches (DSH has its own full typings). */
export interface DshAgent {
  id: string;
  followup(m: DshUserMessage): void;
  steer(m: DshUserMessage): void;
  inject(m: DshUserMessage): void;
  cancel(cause?: unknown): void;
  whenIdle(): Promise<void>;
}
export interface DshUserMessage {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: "user" };
}
export interface DshEvent {
  seq?: number;
  type: string;
  data: Record<string, any>;
}
type SessionListener = (sessionId: string, e: DshEvent) => void;

export class DshHost {
  private ctx: any;
  private shutdownHandle: any;
  private readonly listeners = new Set<SessionListener>();
  /** DSH session id → ash agent id, for attributing tool calls made by DSH agents. */
  private readonly owners = new Map<string, string>();
  version = "";

  constructor(private readonly opts: DshHostOptions) {}

  async boot(world: AshWorld, log: (...a: unknown[]) => void): Promise<void> {
    const { root, home } = this.opts;
    mkdirSync(home, { recursive: true });
    for (const f of [".credentials.yaml", "settings.yaml"]) {
      if (this.opts.seedFrom && !existsSync(join(home, f)) && existsSync(join(this.opts.seedFrom, f))) copyFileSync(join(this.opts.seedFrom, f), join(home, f));
    }
    const prof = join(home, "profiles", "ash");
    mkdirSync(prof, { recursive: true });
    // The profile is core only. ash owns every surface (UI, channels); DSH brings the agent.
    writeFileSync(join(prof, "package.json"), JSON.stringify({ name: "dsh-profile-ash", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 1));
    if (!existsSync(join(prof, "cordis.yml"))) writeFileSync(join(prof, "cordis.yml"), "[]\n");
    if (!existsSync(join(prof, "cordis.patch.yml"))) writeFileSync(join(prof, "cordis.patch.yml"), "[]\n");

    process.env.DSH_HOME = home;
    const req = createRequire(join(root, "package.json"));
    this.version = req(join(root, "package.json")).version;
    const imp = (spec: string) => import(pathToFileURL(req.resolve(spec)).href);
    const { loadLayeredEnv } = await imp("@deepseek-ai/dsh-app-boot");
    const { runProfile } = await import(pathToFileURL(join(root, "lib", "profile-boot.js")).href);
    const { defineTool } = await imp("@deepseek-ai/dsh-tools");
    const t0 = Date.now();
    const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "ash", patchFiles: [], args: [] });
    this.ctx = ctx;
    this.shutdownHandle = shutdown;
    log(`DSH ${this.version} core booted in ${Date.now() - t0} ms (profile ash, home ${home})`);

    // ② the door: ctx.ash for any DSH plugin, plus ash's system services as native tools.
    const owners = this.owners;
    await ctx.plugin({
      name: "ash-door",
      inject: ["tools"],
      apply(c: any) {
        c.provide("ash", world);
        for (const t of ashTools(world, (dshAgentId) => owners.get(dshAgentId))) c.tools.register(defineTool(t));
      },
    });

    // ① observe every session event (assistant messages, tool calls, turn ends …)
    ctx.on("session/event", (session: { id?: string; header?: { id?: string } }, event: DshEvent) => {
      const id = session?.id ?? session?.header?.id ?? "";
      for (const l of this.listeners) l(id, event);
    });
  }

  onSessionEvent(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Every model step of every agent passes here first (loop gate); ash may later reject or rewrite. */
  onPreStep(gate: (sessionId: string, texts: string[]) => boolean | void): void {
    this.ctx.on("agent/pre-step", async (p: { agent: { id: string }; messages: { content: { type: string; text?: string }[] }[] }, next: () => Promise<unknown>) => {
      const texts = p.messages.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text ?? ""));
      if (gate(p.agent.id, texts) === false) return { kind: "reject" };
      return next();
    });
  }

  /** Create or resume one agent (= one durable DSH session) for an ash agent. */
  async agent(ashAgentId: string, cwd: string, sessionId?: string): Promise<{ agent: DshAgent; sessionId: string }> {
    const agents = this.ctx.get("agents");
    const selection = this.ctx.get("agentDefaultModel")?.currentSelection?.();
    const agentOptions = selection ? { provider: selection.provider, model: selection.model } : undefined;
    let handle: { agent: DshAgent };
    if (sessionId && this.ctx.get("sessions")) {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions });
      } catch {
        sessionId = undefined;
      }
    }
    if (!sessionId) {
      sessionId = `session-${randomUUID()}`;
      handle = await agents.create({ sessionId, meta: { cwd }, agentOptions });
    }
    this.owners.set(handle!.agent.id, ashAgentId);
    return { agent: handle!.agent, sessionId };
  }

  modelSelection(): { provider: string; model: string } | undefined {
    return this.ctx?.get("agentDefaultModel")?.currentSelection?.();
  }

  async stop(): Promise<void> {
    await this.shutdownHandle?.shutdown?.("ash stopping");
  }
}

export const userMessage = (text: string, id = randomUUID()): DshUserMessage => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });

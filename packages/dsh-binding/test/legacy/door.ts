// The door: one small DSH plugin through which ash enters the DSH world. Everything it does
// uses DSH's public extension points; it adds no files to DSH and patches nothing.
//
//   ctx.ash                    AgentPort resolver for any DSH plugin (`ctx.ash.portOf(agent)`)
//   ash_* tools                ash system services as native DSH tools
//   <device>__<capability>     the owner's devices, projected live (online/offline, grant/revoke)
//   agent/pre-step             loop gate (step budget) — ash may stop a runaway turn
//   tools/pre-execute          tool gate (sensitive tools from untrusted origins ask the owner)
//   approval/request           DSH's own approval questions go to the owner through ash
//   systemPrompt section       who the agent is in ash (identity, members, how ash works)
//   systemPrompt context       live state ash owns (devices, timers)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallResult } from "../../../sdk/src/api";
import { deviceToolName } from "../../../core/src/mcp";
import type { AgentPort } from "../../../core/src/runtime";
import { runSystemTool, SYSTEM_TOOL_DEFS } from "../../../core/src/tools";
import { type DshHost, userMessage } from "./host";

const OUTPUT = {
  schema: { type: "object", properties: { content: { type: "array", items: {} } }, required: ["content"], additionalProperties: false },
  render(_args: unknown, value: { content?: { type: string; text?: string }[] }) {
    return [{ type: "text", text: (value?.content ?? []).map((c) => c.text ?? "").join("\n") || "(no output)" }];
  },
};

/** Tool results as DSH content; images land in the agent's workspace (the model can read_image them). */
function toValue(port: AgentPort, r: CallResult): { content: { type: "text"; text: string }[] } {
  const out: { type: "text"; text: string }[] = [];
  for (const c of r.content) {
    if (c.type === "text") out.push({ type: "text", text: c.text });
    else if (c.type === "image") {
      const ws = port.whoami().workspace;
      if (!ws) continue;
      const dir = join(ws, ".ash", "media");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${c.mimeType.split("/")[1] ?? "png"}`);
      writeFileSync(file, Buffer.from(c.data, "base64"));
      out.push({ type: "text", text: `[image saved to ${file} — use read_image to look at it]` });
    }
  }
  if (!r.ok) throw new Error(out.map((c) => c.text).join("\n") || r.error || "failed");
  return { content: out.length ? out : [{ type: "text", text: "ok" }] };
}

export async function installDoor(host: DshHost): Promise<void> {
  const ctx = host.ctx;
  const projected = new Map<string, { key: string; dispose: () => void }>();
  let reprojecting = false;

  await ctx.plugin({
    name: "ash-door",
    inject: ["tools", "systemPrompt"],
    apply(c: any) {
      c.provide("ash", { api: "ash-api/1", portOf: (agent: object) => host.portOf(agent), ports: () => host.ports() });

      // ---- system services as native tools
      for (const t of SYSTEM_TOOL_DEFS) {
        c.tools.register({
          name: `ash_${t.name}`,
          description: t.description,
          parameters: t.input_schema,
          output: OUTPUT,
          async execute(args: unknown, exec: { agent?: object; signal?: AbortSignal }) {
            const port = host.portOf(exec.agent);
            if (!port) throw new Error("this agent is not managed by ash");
            return toValue(port, await runSystemTool(port, t.name, (args as Record<string, unknown>) ?? {}, exec.signal));
          },
        });
      }

      // ---- loop gate: a turn over its step budget is told to finish, then stopped
      const warned = new WeakMap<object, number>();
      c.on("agent/pre-step", async (p: { agent: object; turn: number; messages: unknown[] }, next: () => Promise<any>) => {
        const port = host.portOf(p.agent);
        const decision = await next();
        if (!port || decision?.kind !== "enter") return decision;
        const g = port.gateStep();
        if (g.allow) return decision;
        if (warned.get(p.agent) === p.turn) return { kind: "reject" };
        warned.set(p.agent, p.turn);
        return { ...decision, messages: [...decision.messages, userMessage(`[ash] ${g.reason}.`)] };
      });

      // ---- the model chosen on ash's settings page applies to running agents from their next step
      c.on("agent/request", async (p: { agent: object }, next: () => Promise<{ provider: string; model: string }>) => {
        const cfg = await next();
        const sel = host.portOf(p.agent) ? host.agentOptions() : undefined;
        if (!sel || (cfg.provider === sel.provider && cfg.model === sel.model)) return cfg;
        return { ...cfg, provider: sel.provider, model: sel.model };
      });

      // ---- tool gate: DSH's own tools (bash, write …) by the origin of the current message
      c.on("tools/pre-execute", async (exec: { name: string; arguments: unknown; agent?: object; signal: AbortSignal }, next: () => Promise<any>) => {
        const port = host.portOf(exec.agent);
        if (!port || exec.name.startsWith("ash_") || projected.has(exec.name)) return next();
        const d = await port.gateTool(exec.name, exec.arguments, exec.signal);
        if (!d.allow) return { kind: "deny", reason: d.reason };
        return next();
      });

      // ---- DSH approval questions → the owner
      c.on("approval/request", async (req: { agent: object; toolName: string; reason?: string; signal?: AbortSignal }, next: () => Promise<string>) => {
        const port = host.portOf(req.agent);
        if (!port) return next();
        const ok = await port.confirm(`允许 ${req.toolName}？`, req.reason ?? "", "tool", req.signal);
        return ok ? "allowed-once" : "rejected";
      });

      // ---- context ash owns
      const sp = c.systemPrompt;
      sp.section({
        name: "ash:identity",
        order: sp.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") + 1,
        text: (ac: { scope?: object }) => host.portOf(ac.scope)?.contextSections().identity ?? "",
      });
      sp.context({
        name: "ash:state",
        order: 130,
        text: (ac: { scope?: object }) => host.portOf(ac.scope)?.contextSections().state ?? "",
      });
    },
  });

  // ---- devices, projected as tools; re-projected whenever any agent's view changes
  const reproject = () => {
    if (reprojecting) return;
    reprojecting = true;
    queueMicrotask(() => {
      reprojecting = false;
      const want = new Map<string, { device: string; name: string; capability: string; description: string; schema: Record<string, unknown> }>();
      for (const port of host.ports()) {
        for (const { device, capability } of port.projectedCapabilities()) {
          const name = deviceToolName(device.name, device.id, capability.name);
          if (!want.has(name)) want.set(name, { device: device.id, name: device.name, capability: capability.name, description: `[${device.name}] ${capability.description}${capability.confirm ? " (asks the owner first)" : ""}`, schema: capability.input_schema });
        }
      }
      for (const [name, p] of projected) {
        const w = want.get(name);
        if (!w || JSON.stringify(w) !== p.key) {
          p.dispose();
          projected.delete(name);
        }
      }
      for (const [name, w] of want) {
        if (projected.has(name)) continue;
        try {
          const dispose = ctx.tools.register({
            name,
            description: w.description,
            parameters: w.schema && (w.schema as { type?: string }).type === "object" ? w.schema : { type: "object", properties: {} },
            output: OUTPUT,
            async execute(args: unknown, exec: { agent?: object; signal?: AbortSignal }) {
              const port = host.portOf(exec.agent);
              if (!port) throw new Error("this agent is not managed by ash");
              return toValue(port, await port.call(w.device, w.capability, (args as Record<string, unknown>) ?? {}, exec.signal));
            },
          });
          projected.set(name, { key: JSON.stringify(w), dispose });
        } catch (e) {
          ctx.logger?.("ash-door")?.warn?.(`cannot project ${name}: ${e instanceof Error ? e.message : e}`);
        }
      }
      ctx.emit?.("system-prompt/change");
    });
  };
  host.onAgent((port) => {
    port.onCapabilitiesChanged(reproject);
    reproject();
  });
}

// ash system services as agent tools, defined once. Runtime bindings project them: DSH gets
// them as native tools (`ash_<name>`), out-of-process runtimes over MCP (`<server>__<name>`).
// Every tool runs through the calling agent's AgentPort, so it acts on that agent's behalf.

import type { CallResult } from "../../sdk/src/api";
import type { AgentPort } from "./runtime";

export interface SystemTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(port: AgentPort, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult>;
}

const ok = (value: unknown): CallResult => ({ ok: true, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], data: value });
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v;
};

export const SYSTEM_TOOL_DEFS: SystemTool[] = [
  {
    name: "whoami",
    description: "Who you are in ash: your member id, space, owner, workspace directory and the grants you hold.",
    input_schema: { type: "object", properties: {} },
    run: async (p) => ok(p.whoami()),
  },
  {
    name: "members",
    description: "List everyone in this ash space (the owner, agents, devices) and who is online.",
    input_schema: { type: "object", properties: {} },
    run: async (p) => ok({ members: p.members() }),
  },
  {
    name: "devices",
    description: "List the owner's devices (phone, laptops, browsers), whether they are online, and the capabilities you may call on each (use ash_call, or the <device>__<capability> tools).",
    input_schema: { type: "object", properties: {} },
    run: async (p) => ok(p.devices().map((d) => ({ id: d.id, name: d.name, kind: d.kind, online: d.online, capabilities: d.capabilities.map((c) => ({ name: c.name, description: c.description, confirm: c.confirm ?? false })) }))),
  },
  {
    name: "call",
    description: "Call a capability on one of the owner's devices. Some capabilities ask the owner first; the call then waits for the answer.",
    input_schema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device member id, e.g. device:phone" },
        capability: { type: "string", description: "Capability name from ash_devices" },
        args: { type: "object", description: "Arguments as the capability's input schema describes" },
      },
      required: ["device", "capability"],
    },
    run: (p, a, signal) => p.call(str(a.device, "device"), str(a.capability, "capability"), (a.args as Record<string, unknown>) ?? {}, signal),
  },
  {
    name: "send",
    description: "Send a message to another agent in this space (it arrives in their inbox; their reply comes back to you as a new message). To reach the owner use ash_notify.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string", description: "Agent member id, e.g. agent:research" }, text: { type: "string" } },
      required: ["to", "text"],
    },
    run: async (p, a) => ok(p.send(str(a.to, "to"), str(a.text, "text"))),
  },
  {
    name: "timer_set",
    description: "Set a reminder for yourself. When it fires, its text is delivered to you as a new message, so write it as an instruction to your future self. Give in_seconds or at (unix ms); repeat_seconds (>= 60) makes it recurring.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        in_seconds: { type: "number" },
        at: { type: "number", description: "Unix time in milliseconds" },
        repeat_seconds: { type: "number" },
      },
      required: ["text"],
    },
    run: async (p, a) => {
      const t = p.setTimer({ text: str(a.text, "text"), in_seconds: a.in_seconds as number | undefined, at: a.at as number | undefined, repeat_seconds: a.repeat_seconds as number | undefined });
      return ok({ id: t.id, fires_at: new Date(t.fire_at).toISOString(), repeat_seconds: t.repeat_seconds, now: new Date().toISOString() });
    },
  },
  {
    name: "timer_list",
    description: "List your pending reminders.",
    input_schema: { type: "object", properties: {} },
    run: async (p) => ok(p.listTimers().map((t) => ({ id: t.id, text: t.text, fires_at: new Date(t.fire_at).toISOString(), repeat_seconds: t.repeat_seconds }))),
  },
  {
    name: "timer_cancel",
    description: "Cancel one of your reminders by id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (p, a) => ok(p.cancelTimer(str(a.id, "id"))),
  },
  {
    name: "notify",
    description: "Notify the owner on their phone (and paired devices). Use it when something needs their attention while they are not talking to you. urgency high also breaks through quiet hours.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" }, urgency: { type: "string", enum: ["low", "normal", "high"] } },
      required: ["title", "text"],
    },
    run: async (p, a) => ok(await p.notify({ title: str(a.title, "title"), text: String(a.text ?? ""), urgency: (a.urgency as "low" | "normal" | "high") ?? "normal" })),
  },
  {
    name: "log",
    description: "Read the recent event log of your workspace (messages, turns, tool calls, timers, notifications).",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "Default 30, max 200" } } },
    run: async (p, a) => ok(p.log(typeof a.limit === "number" ? a.limit : 30).map((e) => ({ seq: e.seq, at: new Date(e.ts).toISOString(), member: e.member, type: e.type, data: e.data }))),
  },
  {
    name: "grants",
    description: "List the permissions (grants) you hold: which devices and capabilities you may use.",
    input_schema: { type: "object", properties: {} },
    run: async (p) => ok(p.grants()),
  },
  {
    name: "request_grant",
    description: "Ask the owner for a permission you lack (scope: device:<id>/* or device:<id>/<capability>). Waits for the owner's answer.",
    input_schema: {
      type: "object",
      properties: { scope: { type: "string" }, reason: { type: "string", description: "Why you need it (shown to the owner)" } },
      required: ["scope", "reason"],
    },
    run: async (p, a) => ok(await p.requestGrant(str(a.scope, "scope"), str(a.reason, "reason"))),
  },
];

/** Run one system tool, turning thrown errors into failed results. */
export async function runSystemTool(port: AgentPort, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult> {
  const t = SYSTEM_TOOL_DEFS.find((x) => x.name === name);
  if (!t) return { ok: false, content: [{ type: "text", text: `unknown tool ${name}` }], error: "unknown_tool" };
  try {
    return await t.run(port, args ?? {}, signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content: [{ type: "text", text: msg }], error: msg };
  }
}

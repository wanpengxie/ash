// ash system services for agents, as an MCP server (Streamable HTTP, JSON responses).
//
// This is the "runtime → ash" direction that needs no plugin at all: any runtime with an
// MCP client (DSH, Claude Code, Codex, Pi …) mounts `/mcp/<agent>` and gets these tools.
// Every call speaks for exactly one agent (the token decides which).

import type { Core } from "./core";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, agent: string) => Promise<unknown> | unknown;
}

const fmtTime = (ms: number) => new Date(ms).toISOString();

export function systemTools(core: Core): Tool[] {
  return [
    {
      name: "members",
      description:
        "List who is in this personal-agent space: the owner, agents (with status and queue), and devices. Use it to find an agent id before `send`.",
      inputSchema: { type: "object", properties: {} },
      run: () => ({ members: core.listMembers().map(({ id, kind, name, online }) => ({ id, kind, name, online })), agents: core.listAgents().map(({ id, runtime, status, queued }) => ({ id, runtime, status, queued })) }),
    },
    {
      name: "send",
      description:
        "Send a message to another agent in this space (it is queued and handled after its current turn). You will not get its reply here; replies arrive as later messages or in the log.",
      inputSchema: { type: "object", properties: { to: { type: "string", description: "agent id, e.g. agent:main" }, text: { type: "string" } }, required: ["to", "text"] },
      run: (a, agent) => core.deliver(String(a.to), { text: String(a.text) }, agent),
    },
    {
      name: "timer_set",
      description:
        "Set a reminder for yourself. When it fires, `text` is delivered back to you as a new message (from timer:<id>), even after restarts. Use it for 'remind me', follow-ups and periodic checks. Give in_seconds, or at_iso (ISO 8601 with timezone). repeat_seconds (>= 60) makes it recurring.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "what you want to be told when it fires" },
          in_seconds: { type: "number" },
          at_iso: { type: "string", description: "e.g. 2026-09-30T21:00:00+08:00" },
          repeat_seconds: { type: "number" },
        },
        required: ["text"],
      },
      run: (a, agent) => {
        const at = typeof a.at_iso === "string" ? Date.parse(a.at_iso) : undefined;
        if (a.at_iso !== undefined && Number.isNaN(at)) throw new Error("at_iso is not a valid ISO 8601 time");
        const t = core.setTimer({ text: String(a.text), in_seconds: a.in_seconds as number | undefined, at, repeat_seconds: a.repeat_seconds as number | undefined }, agent);
        return { id: t.id, fires_at: fmtTime(t.fire_at), repeat_seconds: t.repeat_seconds, now: fmtTime(Date.now()) };
      },
    },
    {
      name: "timer_list",
      description: "List your pending reminders.",
      inputSchema: { type: "object", properties: {} },
      run: (_a, agent) => core.listTimers(agent).map((t) => ({ id: t.id, text: t.text, fires_at: fmtTime(t.fire_at), repeat_seconds: t.repeat_seconds })),
    },
    {
      name: "timer_cancel",
      description: "Cancel one of your reminders by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a, agent) => core.cancelTimer(String(a.id), agent, agent),
    },
    {
      name: "notify",
      description:
        "Notify the owner (e.g. a phone notification). Keep it short. Use for results they asked to be told about, or something time-sensitive — not for chatter.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, text: { type: "string" }, urgency: { type: "string", enum: ["low", "normal", "high"] } },
        required: ["title", "text"],
      },
      run: (a, agent) => core.notify({ title: String(a.title), text: String(a.text), urgency: a.urgency as "low" | "normal" | "high" | undefined }, agent),
    },
    {
      name: "log",
      description: "Read the recent shared event log of this space (messages, turns, timers, notifications), newest last.",
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 20, max 100" } } },
      run: (a) =>
        core.recent(Math.min(Number(a.limit ?? 20) || 20, 100)).map((e) => ({
          seq: e.seq,
          at: fmtTime(e.ts),
          member: e.member,
          type: e.type,
          data: JSON.stringify(e.data).slice(0, 300),
        })),
    },
  ];
}

/** Handle one MCP JSON-RPC POST body for `agent`; returns [status, body|null]. */
export async function handleMcp(core: Core, agent: string, body: unknown): Promise<[number, unknown]> {
  const tools = systemTools(core);
  const one = async (m: Record<string, unknown>): Promise<unknown> => {
    const id = m.id;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (m.method) {
      case "initialize": {
        const p = (m.params ?? {}) as { protocolVersion?: string };
        return reply({
          protocolVersion: p.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ash", version: "1.0.0" },
          instructions: `You are ${agent} in the owner's personal-agent space (ash). These tools reach the space: reminders that come back to you, messages to other agents, notifications to the owner, and the shared log.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const p = (m.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const tool = tools.find((t) => t.name === p.name);
        if (!tool) return fail(-32602, `unknown tool ${p.name}`);
        try {
          const out = await tool.run(p.arguments ?? {}, agent);
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        if (typeof m.method === "string" && m.method.startsWith("notifications/")) return undefined;
        return fail(-32601, `method not found: ${String(m.method)}`);
    }
  };
  const msgs = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
  const out = (await Promise.all(msgs.map(one))).filter((x) => x !== undefined);
  if (out.length === 0) return [202, null];
  return [200, Array.isArray(body) ? out : out[0]];
}

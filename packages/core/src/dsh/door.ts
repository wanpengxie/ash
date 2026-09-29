// The door into the DSH world: the ash object DSH plugins see as `ctx.ash` (handle ②),
// and ash's system services expressed as native DSH tools.

import type { AshEvent, Timer, TimerRequest } from "../../../sdk/src/api";

/** What the DSH world can do with ash — handle ②. Every call names the acting ash member. */
export interface AshWorld {
  readonly api: string;
  members(): { id: string; kind: string; name: string; online: boolean }[];
  agents(): { id: string; runtime: string; status: string; queued: number }[];
  send(from: string, to: string, text: string): { message_id: string };
  setTimer(owner: string, req: Omit<TimerRequest, "owner">): Timer;
  listTimers(owner: string): Timer[];
  cancelTimer(owner: string, id: string): { cancelled: boolean };
  notify(from: string, title: string, text: string, urgency?: "low" | "normal" | "high"): Promise<{ ok: true }>;
  log(limit: number): AshEvent[];
}

const iso = (ms: number) => new Date(ms).toISOString();

type Params = Record<string, { type: "string" | "number"; required?: boolean; description: string; enum?: string[] }>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Params;
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => { type: "text"; text: string }[] };
  execute(args: Record<string, any>, exec: { agent?: { id: string } }): Promise<unknown>;
}

const json = { schema: { type: "object", additionalProperties: true }, render: (_a: unknown, v: unknown) => [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] };

/**
 * ash's system services as native DSH tools. `ownerOf` maps the calling DSH agent to its
 * ash member id; a DSH agent that ash does not host cannot use them.
 */
export function ashTools(world: AshWorld, ownerOf: (dshAgentId: string) => string | undefined): ToolDef[] {
  const who = (exec: { agent?: { id: string } }) => {
    const me = exec.agent ? ownerOf(exec.agent.id) : undefined;
    if (!me) throw new Error("this agent is not hosted by ash");
    return me;
  };
  return [
    {
      name: "ash_members",
      description: "List who is in this personal-agent space: the owner, agents (status, queue) and devices. Use it to find an agent id before ash_send.",
      parameters: {},
      output: json,
      async execute(_a, exec) {
        who(exec);
        return { members: world.members(), agents: world.agents() };
      },
    },
    {
      name: "ash_send",
      description: "Send a message to another agent in this space. It is queued and handled after that agent's current turn; replies arrive later as messages to you, not here.",
      parameters: { to: { type: "string", required: true, description: "agent id, e.g. agent:main" }, text: { type: "string", required: true, description: "the message" } },
      output: json,
      async execute(a, exec) {
        return world.send(who(exec), String(a.to), String(a.text));
      },
    },
    {
      name: "ash_timer_set",
      description:
        "Set a reminder for yourself. When it fires, `text` comes back to you as a new message (from timer:<id>), even after restarts. Use it for 'remind me', follow-ups and periodic checks. Give in_seconds, or at_iso (ISO 8601 with timezone); repeat_seconds (>= 60) makes it recurring.",
      parameters: {
        text: { type: "string", required: true, description: "what you want to be told when it fires" },
        in_seconds: { type: "number", description: "fire after this many seconds" },
        at_iso: { type: "string", description: "fire at this time, e.g. 2026-09-30T21:00:00+08:00" },
        repeat_seconds: { type: "number", description: "repeat every N seconds (>= 60)" },
      },
      output: json,
      async execute(a, exec) {
        const at = typeof a.at_iso === "string" ? Date.parse(a.at_iso) : undefined;
        if (a.at_iso !== undefined && Number.isNaN(at)) throw new Error("at_iso is not a valid ISO 8601 time");
        const t = world.setTimer(who(exec), { text: String(a.text), in_seconds: a.in_seconds, at, repeat_seconds: a.repeat_seconds });
        return { id: t.id, fires_at: iso(t.fire_at), repeat_seconds: t.repeat_seconds, now: iso(Date.now()) };
      },
    },
    {
      name: "ash_timer_list",
      description: "List your pending reminders.",
      parameters: {},
      output: json,
      async execute(_a, exec) {
        return { timers: world.listTimers(who(exec)).map((t) => ({ id: t.id, text: t.text, fires_at: iso(t.fire_at), repeat_seconds: t.repeat_seconds })) };
      },
    },
    {
      name: "ash_timer_cancel",
      description: "Cancel one of your reminders by id.",
      parameters: { id: { type: "string", required: true, description: "timer id from ash_timer_set / ash_timer_list" } },
      output: json,
      async execute(a, exec) {
        return world.cancelTimer(who(exec), String(a.id));
      },
    },
    {
      name: "ash_notify",
      description: "Notify the owner (e.g. a phone notification). Keep it short. Use it for results they asked to be told about or something time-sensitive — not for chatter.",
      parameters: {
        title: { type: "string", required: true, description: "short title" },
        text: { type: "string", required: true, description: "one or two sentences" },
        urgency: { type: "string", description: "low | normal | high", enum: ["low", "normal", "high"] },
      },
      output: json,
      async execute(a, exec) {
        return world.notify(who(exec), String(a.title), String(a.text), a.urgency);
      },
    },
    {
      name: "ash_log",
      description: "Read the recent shared event log of this space (messages, turns, timers, notifications), newest last.",
      parameters: { limit: { type: "number", description: "default 20, max 100" } },
      output: json,
      async execute(a, exec) {
        who(exec);
        const n = Math.min(Number(a.limit ?? 20) || 20, 100);
        return { events: world.log(n).map((e) => ({ seq: e.seq, at: iso(e.ts), member: e.member, type: e.type, data: JSON.stringify(e.data).slice(0, 300) })) };
      },
    },
  ];
}

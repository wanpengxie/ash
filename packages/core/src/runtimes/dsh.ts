// DSH runtime adapter — attach mode: drive an already running `dsh web` through its public
// Remote API (the same API its own web UI uses). Deeper controls (loop gate, context
// sections, tool projection, approval answerer) arrive with the in-process DSH binding;
// this adapter declares them unsupported until then.
//
// DSH facts this relies on (0.1.7):
//   POST /api/<namespace>/<method>  {"type":"client-request","rpcId","method","payload":{"args":{<wire>:…}}}
//   auth: GET /?token=<process token printed on startup> → authority-bound session cookie (reusable)
//   session/prompt's requestId comes back as the user message's source.rpcId

import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, InboundMessage, RuntimeContext, RuntimeEvent, TurnResult } from "../runtime";

export interface DshOptions {
  /** Engine origin, e.g. http://127.0.0.1:3090 */
  url: string;
  /** Engine log that contains the "dsh web: <url>/?token=…" line. */
  log: string;
  /** Adopt an existing session instead of creating one. */
  sessionId?: string;
  title?: string;
  /** DSH user patch document; when set, ash registers its MCP server there (managed block). */
  patchFile?: string;
  /** Give up on a turn after this long (default 15 min). */
  turnTimeoutMs?: number;
}

type Rec = { seq: number; type: string; data: Record<string, any> };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class DshRuntime implements AgentRuntime {
  readonly kind = "dsh";
  readonly capabilities = {
    deliver_queue: true,
    deliver_steer: true,
    cancel: true,
    events_stream: true,
    resume: true,
    mcp_client: true,
    loop_gate: false, // → in-process binding (agent/pre-step)
    context_sections: false, // → in-process binding (dsh-system-prompt)
    tool_projection: false, // → in-process binding (ctx.tools)
    approval_answerer: false, // → in-process binding (dsh-user-approval)
  };
  private ctx!: RuntimeContext;
  private sessionId = "";
  private cookie: string | null = null;
  private cookieFor: string | null = null;
  private rpcSeq = 0;
  private readonly origin: string;

  constructor(private readonly opts: DshOptions) {
    this.origin = new URL(opts.url).origin;
  }

  handle(): string | undefined {
    return this.sessionId || undefined;
  }

  async start(ctx: RuntimeContext): Promise<void> {
    this.ctx = ctx;
    const saved = join(ctx.stateDir, "dsh-session.json");
    this.sessionId = this.opts.sessionId ?? (existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")).sessionId : "");
    if (!this.sessionId) {
      const v = await this.rpc<{ sessionId: string }>("session/create", { request: { cwd: ctx.workspaceDir } });
      this.sessionId = v.sessionId;
      await this.rpc("session/rename", { request: { sessionId: this.sessionId, title: this.opts.title ?? `Ash · ${ctx.agentId.slice(6)}` } }).catch(() => {});
    }
    writeFileSync(saved, JSON.stringify({ sessionId: this.sessionId }));
    if (this.opts.patchFile && this.ensureMcpEntry(this.opts.patchFile)) {
      ctx.log(`registered ash system services in ${this.opts.patchFile}; DSH picks them up on its next start`);
    }
  }

  async runTurn(msg: InboundMessage, emit: (e: RuntimeEvent) => void, signal: AbortSignal): Promise<TurnResult> {
    let seen = await this.cursor();
    await this.rpc("session/prompt", {
      request: { requestId: msg.message_id, sessionId: this.sessionId, mode: "queue", content: [{ type: "text", text: this.format(msg) }] },
    });
    const deadline = Date.now() + (this.opts.turnTimeoutMs ?? 15 * 60_000);
    let mine = false;
    const toolNames = new Map<string, string>();
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(700, signal);
      const cur = await this.cursor();
      if (cur <= seen) continue;
      for (const r of await this.page(cur)) {
        if (r.seq <= seen) continue;
        if (!mine) {
          if (r.type === "user/message" && r.data?.source?.rpcId === msg.message_id) mine = true;
          continue;
        }
        switch (r.type) {
          case "assistant/message": {
            const text = (r.data?.message?.content ?? [])
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text)
              .join("");
            if (text.trim()) emit({ type: "text", text });
            break;
          }
          case "tool/call":
            toolNames.set(r.data.callId, r.data.name);
            emit({ type: "tool.call", name: r.data.name, args: safeJson(r.data.arguments) });
            break;
          case "tool/result": {
            const m = r.data?.message ?? {};
            const preview = (m.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").slice(0, 300);
            emit({ type: "tool.result", name: toolNames.get(m.toolCallId) ?? "?", ok: !m.isError && !r.data?.error, preview });
            break;
          }
          case "turn/end": {
            const kind = r.data?.reason?.kind;
            if (kind === "completed") return { reason: "completed" };
            if (kind === "interrupted" || kind === "cancelled") return { reason: "cancelled" };
            return { reason: "error", error: r.data?.reason?.error?.message ?? String(kind) };
          }
        }
      }
      seen = cur;
    }
    return signal.aborted ? { reason: "cancelled" } : { reason: "error", error: "turn timed out" };
  }

  async steer(msg: InboundMessage): Promise<void> {
    await this.rpc("session/prompt", {
      request: { requestId: msg.message_id, sessionId: this.sessionId, mode: "steer", content: [{ type: "text", text: this.format(msg) }] },
    });
  }

  async cancel(): Promise<void> {
    await this.rpc("session/cancel", { request: { sessionId: this.sessionId } });
  }

  async stop(): Promise<void> {}

  // ---------------------------------------------------------------- helpers

  /** Until the binding injects context sections, the sender is stated in the message itself. */
  private format(msg: InboundMessage): string {
    if (msg.from === "person:owner") return msg.text;
    if (msg.from.startsWith("timer:")) return `[提醒 ${msg.from.slice(6)}] ${msg.text}`;
    return `[来自 ${msg.from}] ${msg.text}`;
  }

  private async cursor(): Promise<number> {
    const v = await this.rpc<{ items: { sessionId: string; projections?: { asOfSeq?: number } }[] }>("session/list", { _request: {} });
    return v.items.find((i) => i.sessionId === this.sessionId)?.projections?.asOfSeq ?? 0;
  }

  private async page(through: number): Promise<Rec[]> {
    const v = await this.rpc<{ records: { event: Rec }[] }>("session/page", {
      request: { address: { kind: "session", sessionId: this.sessionId }, throughSeq: through, maxMessages: 500 },
    });
    return v.records.map((r) => r.event).sort((a, b) => a.seq - b.seq);
  }

  private async rpc<T = unknown>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = await this.auth(attempt > 0);
      const res = await fetch(`${this.origin}/api/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: `ash-${++this.rpcSeq}`, method: endpoint, payload: { args } }),
      });
      if (res.status === 401 || res.status === 403) continue;
      const body = (await res.json().catch(() => ({}))) as { result?: { ok: boolean; value?: T; error?: { message?: string; code?: string } } };
      if (!res.ok || !body.result) throw new Error(`dsh ${endpoint}: HTTP ${res.status}`);
      if (!body.result.ok) throw new Error(`dsh ${endpoint}: ${body.result.error?.code ?? ""} ${body.result.error?.message ?? ""}`.trim());
      return body.result.value as T;
    }
    throw new Error(`dsh ${endpoint}: not authenticated (no usable token in ${this.opts.log})`);
  }

  private tokenUrl(): string | null {
    try {
      const size = statSync(this.opts.log).size;
      const n = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(n);
      const fd = openSync(this.opts.log, "r");
      readSync(fd, buf, 0, n, size - n);
      closeSync(fd);
      const esc = this.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const all = [...buf.toString("utf8").matchAll(new RegExp(`${esc}/\\?token=[A-Za-z0-9_-]+`, "g"))];
      return all.length ? all[all.length - 1][0] : null;
    } catch {
      return null;
    }
  }

  private async auth(force: boolean): Promise<string | null> {
    const url = this.tokenUrl();
    if (!url) return null;
    if (!force && this.cookie && this.cookieFor === url) return this.cookie;
    const r = await fetch(url, { redirect: "manual" });
    const set = r.headers.getSetCookie();
    if (!set.length) return null;
    this.cookie = set.map((c) => c.split(";")[0]).join("; ");
    this.cookieFor = url;
    return this.cookie;
  }

  /** Keep one managed block in DSH's user patch that mounts ash's MCP server. Returns true if changed. */
  private ensureMcpEntry(file: string): boolean {
    const begin = "# >>> ash-core (managed; do not edit)";
    const end = "# <<< ash-core";
    const headers = Object.entries(this.ctx.mcp.headers)
      .map(([k, v]) => `          ${k}: ${v}`)
      .join("\n");
    const block = [
      begin,
      "- insert:",
      "    - id: mcp-ash",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: ash",
      "        transport: streamable-http",
      `        url: ${this.ctx.mcp.url}`,
      "        headers:",
      headers,
      end,
    ].join("\n");
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end}`);
    const next = re.test(cur) ? cur.replace(re, block) : `${cur.replace(/\n*$/, "\n")}${block}\n`;
    if (next === cur) return false;
    writeFileSync(file, next);
    return true;
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

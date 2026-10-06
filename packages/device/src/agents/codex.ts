import { createHash } from "node:crypto";
import { JsonProcess, type Command, type Frame } from "./process";
import { checkTools, type AgentSession, type OpenOptions } from "./types";
import { AshTools } from "./mcp";

const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

export class CodexSession implements AgentSession {
  private process: JsonProcess;
  private thread = "";
  private active?: { id: string; native?: string; started: boolean; reply: string; usage?: unknown; seen: Set<string> };
  private unavailable = false;
  private model?: string;
  private effort?: string;
  private tools: AshTools;

  private constructor(private options: OpenOptions, command: Command) {
    checkTools(options.tools);
    this.model = options.model; this.effort = options.effort;
    this.tools = new AshTools(options, () => !this.unavailable ? this.active?.id : undefined);
    this.process = new JsonProcess(command, options.cwd);
    this.process.onFrame = frame => this.receive(frame);
    this.process.onExit = reason => {
      this.unavailable = true;
      if (this.active) {
        const active = this.active; this.active = undefined;
        options.onEvent({ type: "turn_ended", turn: active.id, outcome: "unknown", reply: active.reply });
      }
      options.onEvent({ type: "ended", reason });
    };
  }

  static async open(options: OpenOptions, command: Command = { command: "codex", args: ["app-server", "--stdio"] }): Promise<CodexSession> {
    const session = new CodexSession(options, command);
    try {
      await session.process.request("initialize", { clientInfo: { name: "ash", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      session.process.write({ jsonrpc: "2.0", method: "initialized", params: {} });
      const digest = createHash("sha256").update(JSON.stringify(options.tools)).digest("hex").slice(0, 16);
      const prefix = `ash-codex-v1:${digest}:`;
      if (options.seed && !options.seed.startsWith(prefix)) throw new Error("session tool contract changed; open a fresh session");
      const result = await session.process.request(options.seed ? "thread/resume" : "thread/start", {
        ...(options.seed ? { threadId: options.seed.slice(prefix.length) } : {}),
        cwd: options.cwd, model: options.model, approvalPolicy: "never", sandbox: "danger-full-access",
        developerInstructions: options.system,
        ...(!options.seed ? { dynamicTools: options.tools.map(tool => ({ type: "function", ...tool })) } : {}),
      });
      if (typeof result?.thread?.id !== "string") throw new Error("runtime did not return a thread");
      session.thread = result.thread.id;
      options.onEvent({ type: "seed_updated", seed: prefix + session.thread });
      return session;
    } catch (e) { await session.process.close(); throw e; }
  }

  async send(turn: string, text: string): Promise<void> {
    if (this.unavailable) throw new Error("session unavailable; reconcile before retrying");
    if (this.active) throw new Error("session busy");
    const active = this.active = { id: turn, native: undefined as string | undefined, started: false, reply: "", seen: new Set<string>() };
    try {
      const result = await this.process.request("turn/start", { threadId: this.thread, input: textInput(text), model: this.model, effort: this.effort });
      if (typeof result?.turn?.id !== "string") throw new Error("runtime did not accept the turn");
      if (this.active === active) this.bind(result.turn.id);
    } catch (e) {
      // The process may already have started work. Never allow a second turn after an uncertain acceptance.
      this.unavailable = true; throw e;
    }
  }

  async steer(turn: string, text: string): Promise<boolean> {
    const active = this.active;
    if (this.unavailable || !active?.native || active.id !== turn) return false;
    await this.process.request("turn/steer", { threadId: this.thread, expectedTurnId: active.native, input: textInput(text) });
    return true;
  }
  async interrupt(turn: string): Promise<void> {
    if (!this.active?.native || this.active.id !== turn) throw new Error("turn is not running");
    await this.process.request("turn/interrupt", { threadId: this.thread, turnId: this.active.native });
    // Wait for turn/completed; sending interrupt is not completion.
  }
  async select(model?: string, effort?: string): Promise<void> {
    if (this.active || this.unavailable) throw new Error("session is not idle");
    this.model = model; this.effort = effort;
  }
  async close(): Promise<void> { await this.process.close(); }

  private bind(native: string): boolean {
    const active = this.active; if (!active || (active.native && active.native !== native)) return false;
    active.native = native;
    if (!active.started) { active.started = true; this.options.onEvent({ type: "turn_started", turn: active.id }); }
    return true;
  }

  private receive(frame: Frame): void {
    if (frame.id !== undefined && !frame.method) { this.process.settle(frame.id, frame.result, frame.error); return; }
    const p = frame.params ?? {};
    if (frame.id !== undefined) {
      if (frame.method === "item/tool/call") void this.outbound(frame);
      else if (frame.method === "item/commandExecution/requestApproval" || frame.method === "item/fileChange/requestApproval") this.process.response(frame.id, { decision: "decline" });
      else this.process.response(frame.id, undefined, { code: -32601, message: "Unsupported runtime request" });
      return;
    }
    if (p.threadId !== this.thread || !this.active) return;
    const native = p.turnId ?? p.turn?.id;
    if (typeof native !== "string" || (!this.active.native && frame.method !== "turn/started") || !this.bind(native)) return;
    const active = this.active!;
    if (frame.method === "thread/tokenUsage/updated") active.usage = p.tokenUsage;
    if (frame.method === "item/started" || frame.method === "item/completed") {
      const item = p.item ?? {}, end = frame.method === "item/completed";
      const key = `${frame.method}:${item.id}`;
      if (active.seen.has(key)) return;
      active.seen.add(key);
      if (end && ["agentMessage", "reasoning", "plan"].includes(item.type)) {
        const text = item.type === "reasoning" ? (item.summary ?? []).join("\n") : item.text;
        if (typeof text === "string" && text) this.options.onEvent({ type: "note", turn: active.id, kind: item.type === "reasoning" ? "thinking" : item.type === "plan" ? "plan" : "text", text });
        if (item.type === "agentMessage" && item.phase !== "commentary") active.reply = text ?? "";
      } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type)) {
        this.options.onEvent({ type: "tool", turn: active.id, phase: end ? "end" : "start", name: item.tool ?? item.type, summary: item.command });
      }
    }
    if (frame.method === "turn/completed") {
      const final = (p.turn.items ?? []).filter((item: Frame) => item.type === "agentMessage" && item.phase !== "commentary").at(-1);
      this.active = undefined;
      this.options.onEvent({ type: "turn_ended", turn: active.id, outcome: p.turn.status === "completed" ? "ok" : p.turn.status === "interrupted" ? "interrupted" : "failed", reply: final?.text ?? active.reply, usage: active.usage });
    }
  }

  private async outbound(frame: Frame): Promise<void> {
    const p = frame.params ?? {}, active = this.active;
    let result: unknown; let success = false;
    try {
      if (this.unavailable || p.threadId !== this.thread || !active?.native || p.turnId !== active.native || !this.options.tools.some(t => t.name === p.tool) || !p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments)) throw new Error();
      result = await this.tools.call(p.callId, p.tool, p.arguments); success = true;
    } catch { result = { error: "Ash tool unavailable" }; }
    try { this.process.response(frame.id, { contentItems: [{ type: "inputText", text: JSON.stringify(result ?? null) }], success }); } catch { /* runtime closed while waiting */ }
  }
}

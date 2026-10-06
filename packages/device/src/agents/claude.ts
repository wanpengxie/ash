import { randomUUID } from "node:crypto";
import { JsonProcess, type Command, type Frame } from "./process";
import type { AgentSession, OpenOptions } from "./types";
import { AshTools } from "./mcp";

export class ClaudeSession implements AgentSession {
  private process: JsonProcess;
  private tools: AshTools;
  private active?: { id: string; uuid: string; started: boolean; interrupted: boolean; settling?: boolean; reply: string; tools: Map<string, string>; queued: Set<string> };
  private unavailable = false;
  private readonly session: string;
  private constructor(private options: OpenOptions, command?: Command) {
    this.session = options.seed ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/i.test(this.session)) throw new Error("invalid Claude session seed");
    this.tools = new AshTools(options, () => !this.unavailable && this.active?.started ? this.active.id : undefined);
    // This static SDK declaration has no credential. Inline JSON is supported by the CLI
    // and avoids treating Node's extra socket-pipe as a reopenable /dev/fd file on Linux.
    const config = JSON.stringify({ mcpServers: { ash: { type: "sdk", name: "ash", alwaysLoad: true } } });
    const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", config, options.seed ? "--resume" : "--session-id", this.session];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.system) args.push("--append-system-prompt", options.system);
    this.process = new JsonProcess(command ?? { command: "claude", args }, options.cwd);
    this.process.onFrame = frame => this.receive(frame);
    this.process.onExit = reason => {
      this.unavailable = true;
      const active = this.active; this.active = undefined;
      if (active) options.onEvent({ type: "turn_ended", turn: active.id, outcome: "unknown", reply: active.reply });
      options.onEvent({ type: "ended", reason });
    };
  }
  static async open(options: OpenOptions, command?: Command): Promise<ClaudeSession> {
    const session = new ClaudeSession(options, command);
    try {
      await session.control("initialize", { sdkMcpServers: ["ash"] });
      options.onEvent({ type: "seed_updated", seed: session.session });
      return session;
    } catch (e) { await session.process.close(); throw e; }
  }
  private control(subtype: string, params: Frame = {}): Promise<any> {
    return this.process.exchange(randomUUID(), request_id => ({ type: "control_request", request_id, request: { subtype, ...params } }));
  }
  private user(uuid: string, text: string): Frame {
    return { type: "user", uuid, session_id: this.session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } };
  }
  async send(turn: string, text: string): Promise<void> {
    if (this.active || this.unavailable) throw new Error("session is not idle");
    const uuid = randomUUID();
    this.active = { id: turn, uuid, started: false, interrupted: false, reply: "", tools: new Map(), queued: new Set() };
    try { await this.process.exchange(uuid, () => this.user(uuid, text)); }
    catch (e) { this.unavailable = true; throw e; }
  }
  async steer(turn: string, text: string): Promise<boolean> {
    if (this.unavailable || !this.active?.started || this.active.settling || this.active.id !== turn) return false;
    const uuid = randomUUID();
    this.active.queued.add(uuid);
    try { await this.process.exchange(uuid, () => this.user(uuid, text)); return true; }
    catch (e) { this.unavailable = true; throw e; }
  }
  async interrupt(turn: string): Promise<void> {
    if (!this.active || this.active.id !== turn) throw new Error("turn is not running");
    this.active.interrupted = true;
    await this.control("interrupt", { cancel_queued: true });
  }
  async select(model?: string, effort?: string): Promise<void> {
    if (this.active || this.unavailable) throw new Error("session is not idle");
    // Effort is a launch option; reopening with the saved seed applies it without creating a fake user turn.
    if (effort !== this.options.effort) throw new Error("reopen the session with its seed to change effort");
    await this.control("set_model", { model: model ?? null });
    this.options.model = model;
  }
  async close(): Promise<void> { await this.process.close(); }
  private receive(frame: Frame): void {
    if (frame.type === "control_response") {
      const r = frame.response ?? {}; this.process.settle(r.request_id, r.response, r.subtype === "error" ? true : undefined); return;
    }
    if (frame.type === "control_request") { void this.request(frame); return; }
    if (frame.session_id && frame.session_id !== this.session) return;
    const active = this.active; if (!active || frame.parent_tool_use_id) return;
    if (frame.type === "command_lifecycle") {
      if (["queued", "started"].includes(frame.state)) this.process.settle(frame.command_uuid, {});
      if (frame.state === "cancelled") this.process.settle(frame.command_uuid, null, true);
      if (["started", "completed", "cancelled"].includes(frame.state)) active.queued.delete(frame.command_uuid);
      if (frame.command_uuid === active.uuid && frame.state === "started" && !active.started) {
        active.started = true; this.options.onEvent({ type: "turn_started", turn: active.id });
      }
    }
    if (!active.started) {
      if (frame.type === "result" && frame.user_message_uuid === active.uuid) {
        this.process.settle(active.uuid, undefined, true); this.active = undefined;
        this.options.onEvent({ type: "turn_ended", turn: active.id, outcome: "failed", reply: "Runtime rejected the turn before starting" });
      }
      return;
    }
    if (active.settling) return;
    if (frame.type === "assistant" || frame.type === "user") {
      for (const block of frame.message?.content ?? []) {
        if (block.type === "text" || block.type === "thinking") {
          if (frame.type !== "assistant") continue;
          const text = block.text ?? block.thinking;
          if (typeof text !== "string") continue;
          this.options.onEvent({ type: "note", turn: active.id, kind: block.type === "thinking" ? "thinking" : "text", text });
          if (block.type === "text") active.reply = text;
        } else if (block.type === "tool_use") {
          active.tools.set(block.id, block.name);
          this.options.onEvent({ type: "tool", turn: active.id, phase: "start", name: block.name, summary: block.input?.command ?? block.input?.file_path });
        } else if (block.type === "tool_result") {
          const name = active.tools.get(block.tool_use_id); if (!name) continue;
          active.tools.delete(block.tool_use_id);
          this.options.onEvent({ type: "tool", turn: active.id, phase: "end", name });
        }
      }
    }
    // Results delimit serial provider runs; a steered/background-started run can use a different UUID.
    if (frame.type === "result" && (!(frame.terminal_reason ?? "").startsWith("aborted_") || active.interrupted || frame.user_message_uuid === active.uuid)) void this.finish(frame);
  }
  private async finish(frame: Frame): Promise<void> {
    const active = this.active!; active.settling = true;
    if (active.queued.size) {
      for (const id of active.queued) this.process.settle(id, undefined, true);
      try { await this.control("interrupt", { cancel_queued: true }); }
      catch { this.unavailable = true; }
    }
    if (this.active !== active) return;
    this.active = undefined;
    this.options.onEvent({ type: "turn_ended", turn: active.id, outcome: active.interrupted ? "interrupted" : frame.is_error ? "failed" : "ok", reply: frame.result ?? active.reply, usage: frame.usage });
  }
  private async request(frame: Frame): Promise<void> {
    const req = frame.request ?? {};
    let response: unknown, error = false;
    if (req.subtype === "can_use_tool") {
      response = { behavior: this.options.tools.some(t => `mcp__ash__${t.name}` === req.tool_name) ? "allow" : "deny" };
    } else if (req.subtype === "mcp_message" && req.server_name === "ash") {
      response = { mcp_response: await this.tools.handle(req.message ?? {}) };
    } else { response = "Unsupported runtime request"; error = true; }
    try { this.process.write({ type: "control_response", response: { subtype: error ? "error" : "success", request_id: frame.request_id, ...(error ? { error: response } : { response }) } }); } catch { /* closed */ }
  }
}

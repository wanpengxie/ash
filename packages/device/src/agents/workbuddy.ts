import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonProcess, type Command, type Frame } from "./process";
import { AshTools, serveTools } from "./mcp";
import type { AgentSession, OpenOptions } from "./types";

export function workbuddyEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of ["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_BASE_URL", "CODEBUDDY_CUSTOM_HEADERS", "CODEBUDDY_INTERNET_ENVIRONMENT", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "ACC_PRODUCT_CONFIG_PATH", "CODEBUDDY_HOST", "CODEBUDDY_FORCE_HEADLESS_BUNDLE", "CODEBUDDY_API_KEY_HELPER_DISABLED"]) delete result[key];
  return { ...result, CODEBUDDY_HOST: "workbuddy-desktop", CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1", CODEBUDDY_API_KEY_HELPER_DISABLED: "1", CODEBUDDY_CONFIG_DIR: join(homedir(), ".workbuddy") };
}

export class WorkBuddySession implements AgentSession {
  private process!: JsonProcess;
  private endpoint?: Awaited<ReturnType<typeof serveTools>>;
  private tools: AshTools;
  private session = "";
  private unavailable = false;
  private selecting = false;
  private model?: string;
  private effort?: string;
  private active?: { id: string; reply: string; thinking: string; text: string; usage?: unknown; toolNames: Map<string, string> };

  private constructor(private options: OpenOptions) {
    this.tools = new AshTools(options, () => !this.unavailable ? this.active?.id : undefined);
  }
  static async open(options: OpenOptions, command?: Command): Promise<WorkBuddySession> {
    const session = new WorkBuddySession(options);
    try {
      const digest = createHash("sha256").update(JSON.stringify(options.tools)).digest("hex").slice(0, 16);
      const prefix = `ash-workbuddy-v1:${digest}:`;
      if (options.seed && !options.seed.startsWith(prefix)) throw new Error("session tool contract changed; open a fresh session");
      session.endpoint = await serveTools(session.tools);
      const desktop = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
      const args = ["--acp", "--acp-transport", "stdio", "--strict-mcp-config", "--setting-sources", "", "--permission-mode", "bypassPermissions"];
      if (options.system) args.push("--append-system-prompt", options.system);
      session.process = new JsonProcess(command ?? { command: existsSync(desktop) ? desktop : "codebuddy", args, env: workbuddyEnvironment() }, options.cwd);
      session.process.onFrame = frame => session.receive(frame);
      session.process.onExit = reason => {
        session.unavailable = true; session.endpoint?.close();
        session.finish("unknown"); options.onEvent({ type: "ended", reason });
      };
      await session.process.request("initialize", { protocolVersion: 1, clientInfo: { name: "ash", version: "0.1.0" }, clientCapabilities: {} });
      const loaded = options.seed?.slice(prefix.length);
      const result = await session.process.request(loaded ? "session/load" : "session/new", {
        cwd: options.cwd, ...(loaded ? { sessionId: loaded } : {}),
        mcpServers: [{ type: "http", name: "ash", url: session.endpoint.url, headers: [{ name: "Authorization", value: `Bearer ${session.endpoint.token}` }] }],
      });
      session.session = result?.sessionId ?? loaded;
      if (!session.session) throw new Error("runtime did not return a session");
      session.model = result?.models?.currentModelId;
      session.effort = result?.configOptions?.find((o: Frame) => o.id === "thought_level")?.currentValue;
      if (options.model || options.effort) await session.select(options.model, options.effort);
      options.onEvent({ type: "seed_updated", seed: prefix + session.session });
      return session;
    } catch (e) { await session.close(); throw e; }
  }
  async send(turn: string, text: string): Promise<void> {
    if (this.active || this.selecting || this.unavailable) throw new Error("session is not idle");
    this.active = { id: turn, reply: "", thinking: "", text: "", toolNames: new Map() };
    // ACP prompt's response is the end of the turn, not an acceptance response.
    const completion = this.process.request("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text }] }, 0);
    this.options.onEvent({ type: "turn_started", turn });
    void completion.then(result => {
      if (this.active?.id !== turn) return;
      this.finish(result?.stopReason === "cancelled" ? "interrupted" : "ok");
    }, () => {
      if (this.active?.id !== turn) return;
      this.unavailable = true; this.finish("unknown");
    });
  }
  async steer(turn: string, text: string): Promise<boolean> {
    if (this.unavailable || this.active?.id !== turn) return false;
    const result = await this.process.request("session/steer", { sessionId: this.session, contentBlocks: [{ type: "text", text }] });
    return result?.steered === true;
  }
  async interrupt(turn: string): Promise<void> {
    if (this.active?.id !== turn) throw new Error("turn is not running");
    this.process.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } });
  }
  async select(model = this.model, effort = this.effort): Promise<void> {
    if (this.active || this.selecting || this.unavailable) throw new Error("session is not idle");
    this.selecting = true;
    const previous = this.model;
    try {
      if (model && model !== this.model) await this.process.request("session/set_model", { sessionId: this.session, modelId: model });
      if (effort && effort !== this.effort) await this.process.request("session/set_config_option", { sessionId: this.session, configId: "thought_level", value: effort });
      this.model = model; this.effort = effort;
    } catch (e) {
      // A failed/timed-out setting could already have applied. Retire rather than guess and run with it.
      this.unavailable = true;
      if (previous && previous !== model) {
        try { await this.process.request("session/set_model", { sessionId: this.session, modelId: previous }); } catch { /* keep unavailable */ }
      }
      throw e;
    } finally { this.selecting = false; }
  }
  async close(): Promise<void> { this.endpoint?.close(); await this.process?.close(); }
  private finish(outcome: "ok" | "interrupted" | "unknown"): void {
    const active = this.active; if (!active) return;
    this.flush("text", true); this.flush("thinking", true); this.active = undefined;
    this.options.onEvent({ type: "turn_ended", turn: active.id, outcome, reply: active.reply, usage: active.usage });
  }
  private flush(kind: "text" | "thinking", all = false): void {
    const active = this.active!;
    const pos = all ? active[kind].length : active[kind].lastIndexOf("\n\n") + 2;
    if ((!all && pos < 2) || !pos) return;
    const text = active[kind].slice(0, pos); active[kind] = active[kind].slice(pos);
    if (text.trim()) this.options.onEvent({ type: "note", turn: active.id, kind, text });
  }
  private receive(frame: Frame): void {
    if (frame.id !== undefined && !frame.method) { this.process.settle(frame.id, frame.result, frame.error); return; }
    if (frame.id !== undefined) {
      if (frame.method === "session/request_permission") this.process.response(frame.id, { outcome: { outcome: "cancelled" } });
      else if (frame.method === "_codebuddy.ai/question") this.process.response(frame.id, { outcome: "cancelled" });
      else this.process.response(frame.id, undefined, { code: -32601, message: "Unsupported runtime request" });
      return;
    }
    const active = this.active, p = frame.params;
    if (frame.method !== "session/update" || p?.sessionId !== this.session || !active) return;
    const update = p.update ?? {};
    if (["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) && update.content?.type === "text") {
      const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
      active[kind] += update.content.text;
      if (kind === "text") active.reply += update.content.text;
      this.flush(kind);
    } else if (update.sessionUpdate === "plan") {
      this.options.onEvent({ type: "note", turn: active.id, kind: "plan", text: (update.entries ?? []).map((e: Frame) => `${e.status}: ${e.content}`).join("\n") });
    } else if (update.sessionUpdate === "usage_update") active.usage = { used: update.used, size: update.size };
    else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      this.flush("text", true); this.flush("thinking", true);
      if (update.title || update.kind) active.toolNames.set(update.toolCallId, update.title ?? update.kind);
      this.options.onEvent({ type: "tool", turn: active.id, phase: ["completed", "failed"].includes(update.status) ? "end" : "start", name: active.toolNames.get(update.toolCallId) ?? "tool" });
    }
  }
}

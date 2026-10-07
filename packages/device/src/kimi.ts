import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilitySpec, CallResult } from "../../sdk/src/api";
import { redact } from "./redact";

// Protocol observed in WebBridge's installed extension: hello/tool_call/tool_result.
// Publish only its supported commands, never advertise speculative browser operations.
const actions = ["navigate", "snapshot", "click", "fill", "evaluate", "screenshot", "upload", "network"] as const;
export const KIMI_CAPABILITIES: CapabilitySpec[] = actions.map(action => ({
  name: `browser.${action}`, label: `电脑网页 · ${action}`, description: `Kimi WebBridge ${action}, limited to a tab created for this caller's task. Start with navigate {url}. snapshot returns CSS/@e references; click/fill use selector; fill also uses value; evaluate uses code; upload uses selector/files; network uses cmd. Results containing images are saved as computer file paths.`,
  risk: ["navigate", "snapshot", "screenshot"].includes(action) ? "none" as const : "structure" as const,
  effect: ["navigate", "snapshot", "screenshot"].includes(action) ? "read" : "act",
  input_schema: { type: "object", additionalProperties: false, required: ["task", "args"], properties: {
    task: { type: "string", minLength: 1, maxLength: 120 }, args: { type: "object" },
  } },
}));

/** A loopback listener for the extension, not a client to someone else's browser endpoint. */
export class KimiBridge {
  private server?: Server;
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private ready = false;
  private tabs = new Map<string, number>();
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private calling = false;
  private refOwner = "";
  url = "";
  constructor(private readonly stateDir: string) {}
  get online(): boolean { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  get busy(): boolean { return this.calling; }
  async start(ports = [10086, 10089, 10090, 10091]): Promise<void> {
    for (const port of ports) {
      const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
      try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
      catch { server.close(); continue; }
      this.server = server; this.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
      const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
      server.on("upgrade", (request, socket, head) => {
        // Ordinary websites may not drive the local endpoint; only the installed extension connects.
        const origin = request.headers.origin;
        if (request.url !== "/ws" || !origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || this.socket) { socket.destroy(); return; }
        wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
      });
      wss.on("connection", (socket: WebSocket) => {
        this.socket = socket;
        socket.on("message", bytes => {
          try {
            const frame = JSON.parse(bytes.toString());
            if (frame.type === "hello") { this.ready = true; socket.send(JSON.stringify({ type: "hello_ack" })); return; }
            if (frame.type !== "tool_result") return;
            const pending = this.pending.get(frame.responseToRequestId); if (!pending) return;
            this.pending.delete(frame.responseToRequestId); clearTimeout(pending.timer);
            frame.payload?.error ? pending.reject(new Error("Browser command failed")) : pending.resolve(frame.payload?.data);
          } catch { socket.close(1003, "Invalid browser frame"); }
        });
        socket.on("error", () => socket.close());
        socket.on("close", () => { this.socket = undefined; this.ready = false; this.tabs.clear(); this.failPending(); });
      });
      return;
    }
    throw new Error("No free loopback browser port");
  }
  private failPending(): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser disconnected; result unknown")); } this.pending.clear(); }
  private command(name: string, args: Record<string, unknown>): Promise<any> {
    if (!this.online) throw new Error("Browser extension is not connected");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(), timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Browser result unknown; do not repeat an action blindly")); }, 45000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: "tool_call", requestId, payload: { name, args } }));
    });
  }
  async call(name: string, input: Record<string, unknown>, caller: string, signal?: AbortSignal): Promise<CallResult> {
    const action = name.slice(8), task = input.task, supplied = input.args;
    if (!(actions as readonly string[]).includes(action) || typeof task !== "string" || !task || task.length > 120 || !supplied || typeof supplied !== "object" || Array.isArray(supplied)) return { ok: false, error: "Invalid browser arguments", content: [] };
    if (this.calling) return { ok: false, error: "Browser is busy; wait for the current command", content: [] };
    this.calling = true;
    try {
      signal?.throwIfAborted();
      const key = JSON.stringify([caller, task]), tab = this.tabs.get(key);
      if (!tab && action !== "navigate") throw new Error("Open this task's tab with browser.navigate first");
      const args = Object.fromEntries(Object.entries(supplied).filter(([key]) => !key.startsWith("_") && key !== "newTab"));
      if (typeof args.selector === "string" && /^@?e\d+$/.test(args.selector) && this.refOwner !== key) throw new Error("Page references are stale; take a new snapshot of this task first");
      if (action === "navigate" && (typeof args.url !== "string" || !/^https?:\/\//i.test(args.url))) throw new Error("Use an http or https URL");
      const result = await this.command(action, { ...args, ...(tab ? { _tabId: tab } : { newTab: true, _session: `ash-${randomUUID()}` }) });
      if (action === "navigate" && Number.isSafeInteger(result?.tabId)) this.tabs.set(key, result.tabId);
      if (action === "snapshot") this.refOwner = key;
      else if (["navigate", "click", "fill", "evaluate"].includes(action)) this.refOwner = "";
      // Cancellation does not prove the browser action was undone; never replay or misreport it.
      signal?.throwIfAborted();
      let data = redact(result);
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      if (action === "screenshot" && typeof result?.data === "string") {
        const path = join(this.stateDir, `browser-${randomUUID()}.${result.format === "jpeg" ? "jpg" : "png"}`);
        await writeFile(path, Buffer.from(result.data, "base64"), { mode: 0o600 }); data = { path };
      } else if (Buffer.byteLength(JSON.stringify(data) ?? "") > 50000) {
        const text = JSON.stringify(data), path = join(this.stateDir, `browser-${randomUUID()}.json`);
        await writeFile(path, text, { mode: 0o600 }); data = { path, preview: text.slice(0, 12000), truncated: true };
      }
      return { ok: true, data, content: [{ type: "text", text: JSON.stringify(data) ?? "null" }] };
    } catch (error) { return { ok: false, error: signal?.aborted ? "Browser command cancelled; its effect may already have happened" : String((error as Error).message), content: [] }; }
    finally { this.calling = false; }
  }
  async close(): Promise<void> { this.failPending(); this.socket?.terminate(); this.wss?.close(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }
}

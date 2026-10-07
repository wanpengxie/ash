import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redactText } from "../redact";

export type Frame = Record<string, any>;
export interface Command { command: string; args: string[]; env?: NodeJS.ProcessEnv }

/** Small NDJSON transport. Only control calls time out; a running turn has no deadline here. */
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve(v: any): void; reject(e: Error): void; timer?: NodeJS.Timeout }>();
  private nextId = 0;
  private stopped = false;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private killTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;
  private closed?: () => void;
  onFrame: (frame: Frame) => void = () => {};
  onExit: (reason: string) => void = () => {};

  constructor(command: Command, cwd: string) {
    this.child = spawn(command.command, command.args, {
      cwd, env: command.env ?? process.env, stdio: "pipe", detached: process.platform !== "win32",
    });
    // Stderr may contain credentials. Drain it, but never forward raw runtime diagnostics.
    this.child.stderr.resume();
    this.child.stderr.on("error", () => this.fail("runtime diagnostics closed"));
    this.child.stdout.on("error", () => this.fail("runtime output closed"));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) return this.fail("runtime frame too large");
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
          this.onFrame(frame);
        } catch { return this.fail("invalid runtime frame"); }
      }
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.fail("runtime frame too large");
    });
    this.child.stdin.on("error", () => this.fail("runtime input closed"));
    this.child.once("error", () => this.fail("runtime could not start"));
    this.child.once("exit", (code, signal) => {
      this.finish(`runtime exited (${signal ?? code})`);
      if (!this.groupAlive()) { clearTimeout(this.killTimer); this.closed?.(); }
    });
  }

  write(frame: Frame): void {
    if (this.stopped) throw new Error("runtime is closed");
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("runtime input too large");
    this.child.stdin.write(line);
  }

  request(method: string, params: Frame, timeoutMs = 45_000): Promise<any> {
    return this.exchange(String(++this.nextId), id => ({ jsonrpc: "2.0", id, method, params }), timeoutMs);
  }

  exchange(id: string, frame: (id: string) => Frame, timeoutMs = 45_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); reject(new Error("runtime control timed out; result unknown"));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(frame(id)); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  response(id: string | number, result: unknown, error?: unknown): void {
    this.write({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
  }

  settle(id: string | number, result: unknown, error?: unknown): boolean {
    const p = this.pending.get(String(id)); if (!p) return false;
    this.pending.delete(String(id)); clearTimeout(p.timer);
    // Keep actionable diagnostics, but never forward raw credential-bearing frames.
    const message = error && typeof error === "object" && typeof (error as Frame).message === "string" ? redactText((error as Frame).message).slice(0, 4096) : "runtime rejected request";
    error ? p.reject(new Error(message)) : p.resolve(result);
    return true;
  }

  private finish(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear(); this.onExit(reason);
  }

  fail(reason: string): void { this.finish(reason); void this.close(); }

  private groupAlive(): boolean {
    try { if (!this.child.pid) return false; process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, 0); return true; } catch { return false; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.finish("runtime closed");
    const kill = (signal: NodeJS.Signals) => {
      try { if (this.child.pid) process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, signal); } catch { /* already gone */ }
    };
    this.closing = new Promise(resolve => {
      this.closed = resolve; kill("SIGTERM");
      if (!this.groupAlive()) { resolve(); return; }
      // The parent exiting does not prove its children stopped. Escalate for the whole group.
      this.killTimer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 3000);
    });
    return this.closing;
  }
}

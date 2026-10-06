import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, closeSync, openSync, writeSync } from "node:fs";
import { glob, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import Ajv from "ajv";
import type { CallResult, CapabilitySpec, WordEffect } from "../../sdk/src/api";
import { redact, redactText } from "./redact";

const MAX = 4 * 1024 * 1024, PREVIEW = 50 * 1024;
const str = { type: "string" }, path = { type: "string", minLength: 1 };
const count = (max: number) => ({ type: "integer", minimum: 1, maximum: max });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const base = { workdir: path };
type Spec = CapabilitySpec & { effect: WordEffect; label: string };
const spec = (name: string, description: string, input: Record<string, unknown>, effect: WordEffect = "read"): Spec =>
  ({ name: `workspace.${name}`, label: description, description, input_schema: input, effect, risk: effect === "read" ? "none" : "structure" });
export const WORKSPACE_CAPABILITIES: Spec[] = [
  spec("ls", "列出电脑目录", schema({ ...base, path, limit: count(1000) })),
  spec("read", "读取电脑文件或图片", schema({ ...base, path, offset: count(Number.MAX_SAFE_INTEGER), limit: count(100_000) }, ["path"])),
  spec("find", "按文件名模式查找", schema({ ...base, path, pattern: path, limit: count(1000) }, ["pattern"])),
  spec("grep", "搜索电脑文件内容", schema({ ...base, path, pattern: str, glob: path, literal: { type: "boolean" }, ignoreCase: { type: "boolean" }, context: { type: "integer", minimum: 0, maximum: 20 }, limit: count(1000) }, ["pattern"])),
  spec("write", "写入电脑文件", schema({ ...base, path, content: str }, ["path", "content"]), "write"),
  spec("edit", "精确修改电脑文件", schema({ ...base, path, edits: { type: "array", minItems: 1, maxItems: 1000, items: schema({ oldText: path, newText: str }, ["oldText", "newText"]) } }, ["path", "edits"]), "write"),
  spec("bash", "在电脑上执行命令", schema({ ...base, command: path, timeout: count(86400), yield_ms: { type: "integer", minimum: 0, maximum: 30000 } }, ["command"]), "execute"),
  spec("poll", "读取命令的新输出", schema({ process: path, yield_ms: { type: "integer", minimum: 0, maximum: 30000 } }, ["process"])),
  spec("signal", "停止电脑上的命令", schema({ process: path, signal: { enum: ["INT", "TERM"] } }, ["process", "signal"]), "act"),
];
const ajv = new Ajv();
const validators = new Map(WORKSPACE_CAPABILITIES.map(s => [s.name, ajv.compile(s.input_schema)]));
class Failure extends Error { constructor(readonly code: string, message: string) { super(message); } }
type Job = { id: string; child: ChildProcess; file: string; bytes: number; offset: number; done: boolean; code: number | null;
  error?: string; finished?: number; settle: Promise<void>; killTimer?: ReturnType<typeof setTimeout> };

/** The OS account is the filesystem boundary; approval is enforced on the phone. */
export class Workspace {
  private jobs = new Map<string, Job>();
  constructor(readonly workdir: string, readonly stateDir: string) {}
  private expand(p: string): string { return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p; }
  private cwd(args: Record<string, any>): string { return resolve(this.expand(this.workdir), this.expand(args.workdir ?? ".")); }
  private path(args: Record<string, any>): string { return resolve(this.cwd(args), this.expand(args.path ?? ".")); }
  private result(data: unknown): CallResult {
    const safe = redact(data), changed = JSON.stringify(data) !== JSON.stringify(safe);
    return { ok: true, data: changed && safe && typeof safe === "object" ? { ...safe, redacted: true } : safe,
      content: [{ type: "text", text: typeof safe === "string" ? safe : JSON.stringify(safe) }] };
  }
  private async spill(text: string): Promise<{ path: string; preview: string; truncated: true }> {
    const folder = join(this.stateDir, "spill"); await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${randomUUID()}.txt`); await writeFile(file, text, { mode: 0o600 });
    return { path: file, preview: text.slice(0, PREVIEW / 4) + "\n…\n" + text.slice(-PREVIEW / 4), truncated: true };
  }
  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<CallResult> {
    try {
      const validate = validators.get(name);
      if (!validate || !validate(args)) throw new Failure("bad_args", "Arguments do not match the capability schema");
      signal?.throwIfAborted();
      const value = await this.execute(name.slice(10), args, signal);
      if (value && typeof value === "object" && "content" in value) return value as CallResult;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      // File reads remain directly readable. Other oversized results always include a full file path.
      const hasFile = value && typeof value === "object" && "path" in value && "truncated" in value;
      return this.result(Buffer.byteLength(text) > PREVIEW && name !== "workspace.read" && !hasFile ? await this.spill(text) : value);
    } catch (error) {
      const e = error as Error & { code?: string };
      const code = e.code === "ENOENT" ? "not_found" : e.code ?? (signal?.aborted ? "cancelled" : "failed");
      return { ok: false, error: redactText(e.message), data: { code }, content: [{ type: "text", text: redactText(e.message) }] };
    }
  }
  private async execute(name: string, a: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
    const file = this.path(a);
    switch (name) {
      case "ls": {
        const entries = await readdir(file, { withFileTypes: true });
        return { path: file, truncated: entries.length > (a.limit ?? 1000), entries: await Promise.all(entries.slice(0, a.limit ?? 1000).map(async e => ({
          name: e.name, type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file", size: (await stat(join(file, e.name)).catch(() => null))?.size ?? null,
        }))) };
      }
      case "read": return this.read(file, a.offset ?? 1, a.limit ?? 2000, signal);
      case "write": {
        if (Buffer.byteLength(a.content) > MAX) throw new Failure("too_large", "Write exceeds 4 MiB");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, a.content, { mode: 0o600 }); return { path: file, bytes: Buffer.byteLength(a.content) };
      }
      case "edit": {
        const target = await realpath(file), info = await stat(target);
        if (info.size > MAX) throw new Failure("too_large", "Edit exceeds 4 MiB");
        let text = await readFile(target, "utf8");
        for (const { oldText, newText } of a.edits) {
          const at = text.indexOf(oldText);
          if (at < 0 || text.indexOf(oldText, at + 1) >= 0) throw new Failure("bad_args", "Each oldText must match exactly once; no changes saved");
          text = text.slice(0, at) + newText + text.slice(at + oldText.length);
        }
        if (Buffer.byteLength(text) > MAX) throw new Failure("too_large", "Edited file exceeds 4 MiB");
        const temp = `${target}.ash-${randomUUID()}`;
        await writeFile(temp, text, { mode: info.mode & 0o777 }); await rename(temp, target);
        return { path: file, edits: a.edits.length };
      }
      case "find": {
        const paths: string[] = [], limit = a.limit ?? 1000;
        for await (const p of glob(a.pattern, { cwd: file })) { signal?.throwIfAborted(); if (paths.length === limit) return { paths, truncated: true }; paths.push(resolve(file, p)); }
        return { paths, truncated: false };
      }
      case "grep": return this.grep(file, a, signal);
      case "bash": return this.start(a, signal);
      case "poll": return this.poll(String(a.process), a.yield_ms ?? 1000, signal);
      case "signal": {
        const job = this.job(String(a.process)); if (!job.done) this.kill(job, a.signal === "INT" ? "SIGINT" : "SIGTERM");
        return { process: job.id, signalled: !job.done };
      }
    }
    throw new Failure("bad_args", "Unknown workspace capability");
  }
  private async read(file: string, offset: number, limit: number, signal?: AbortSignal): Promise<unknown> {
    const type = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(file).toLowerCase()];
    if (type) {
      if ((await stat(file)).size > MAX) throw new Failure("too_large", "Image exceeds 4 MiB");
      return { ok: true, content: [{ type: "image", data: (await readFile(file)).toString("base64"), mimeType: type }] } satisfies CallResult;
    }
    const source = createReadStream(file, { signal });
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    const output: string[] = []; let n = 0, bytes = 0, truncated = false;
    // Forward file errors; readline itself does not forward its input errors.
    let failure: Error | undefined; source.on("error", e => { failure = e; lines.close(); });
    try {
      for await (const line of lines) {
        signal?.throwIfAborted(); n++;
        if (n < offset) continue;
        if (Buffer.byteLength(line) > MAX && output.length === 0) throw new Failure("too_large", "A single line exceeds 4 MiB; use grep or a command to read a smaller part");
        if (output.length >= limit || bytes + Buffer.byteLength(line) > MAX) { truncated = true; break; }
        output.push(line); bytes += Buffer.byteLength(line) + 1;
      }
      if (failure) throw failure;
      return { path: file, text: output.join("\n"), offset, next_offset: offset + output.length, truncated };
    } finally { lines.close(); source.destroy(); }
  }
  private async grep(root: string, a: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
    const info = await stat(root), cwd = info.isDirectory() ? root : dirname(root);
    const args = ["--json", "--max-columns", "2000", "--max-columns-preview", ...(a.ignoreCase ? ["-i"] : []), ...(a.literal ? ["-F"] : []),
      ...(a.glob ? ["--glob", String(a.glob)] : []), ...(a.context ? ["-C", String(a.context)] : []), "--", String(a.pattern), root];
    // Use rg when installed; the fallback keeps a fresh installation usable.
    const matches: unknown[] = [], limit = a.limit ?? 100;
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    let missing = false, error = "";
    const ended = new Promise<number | null>(resolve => { child.on("error", e => { missing = (e as NodeJS.ErrnoException).code === "ENOENT"; error = e.message; }); child.on("close", resolve); });
    child.stderr!.on("data", d => { error = (error + String(d)).slice(-2000); });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of lines) {
      let item; try { item = JSON.parse(line); } catch { continue; }
      if (item.type !== "match" && item.type !== "context") continue;
      const d = item.data;
      matches.push({ path: d.path.text, line: d.line_number, text: String(d.lines.text ?? "").slice(0, 2000), context: item.type === "context" });
      if (matches.length >= limit) { child.kill(); break; }
    }
    const code = await ended;
    if (!missing) {
      if (code !== 0 && code !== 1 && matches.length < limit) throw new Failure("failed", error || "Search failed");
      return { matches, truncated: matches.length >= limit };
    }
    const regex = a.literal ? null : new RegExp(a.pattern, a.ignoreCase ? "i" : "");
    const files = info.isDirectory() ? glob(a.glob ?? "**/*", { cwd }) : [root];
    for await (const p of files) {
      signal?.throwIfAborted();
      const file = isAbsolute(p) ? p : join(cwd, p), entry = await stat(file).catch(() => null);
      if (!entry?.isFile() || entry.size > MAX) continue;
      const text = await readFile(file, "utf8"); if (text.includes("\0")) continue;
      const rows = text.split(/\r?\n/); const selected = new Set<number>();
      for (let i = 0; i < rows.length; i++) {
        const hit = regex ? regex.test(rows[i]) : (a.ignoreCase ? rows[i].toLowerCase().includes(a.pattern.toLowerCase()) : rows[i].includes(a.pattern));
        if (!hit) continue;
        for (let j = Math.max(0, i - (a.context ?? 0)); j <= Math.min(rows.length - 1, i + (a.context ?? 0)); j++) {
          if (selected.has(j)) continue; selected.add(j);
          matches.push({ path: file, line: j + 1, text: rows[j].slice(0, 2000), context: j !== i });
          if (matches.length >= limit) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }
  private job(id: string): Job {
    for (const [key, job] of this.jobs) if (job.finished && Date.now() - job.finished > 600_000) this.jobs.delete(key);
    const job = this.jobs.get(id); if (!job) throw new Failure("unknown_process", "Process is unknown; do not rerun without checking its effects"); return job;
  }
  private kill(job: Job, signal: NodeJS.Signals): void {
    if (job.child.pid) try { process.kill(-job.child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
  private async start(a: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
    if ([...this.jobs.values()].filter(j => !j.done).length >= 16) throw new Failure("failed", "At most 16 commands may run at once");
    const folder = join(this.stateDir, "spill"); await mkdir(folder, { recursive: true, mode: 0o700 });
    const id = randomUUID(), file = join(folder, `${id}.txt`), fd = openSync(file, "wx", 0o600);
    const child = spawn("bash", ["-lc", a.command], { cwd: this.cwd(a), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let done!: () => void;
    const job: Job = { id, child, file, bytes: 0, offset: 0, done: false, code: null, settle: new Promise(r => done = r) };
    this.jobs.set(id, job);
    const append = (data: Buffer) => { try { writeSync(fd, data); job.bytes += data.length; } catch { job.error = "Cannot save command output"; this.kill(job, "SIGKILL"); } };
    child.stdout!.on("data", append); child.stderr!.on("data", append);
    child.on("error", e => { job.error = e.message; });
    const timer = a.timeout ? setTimeout(() => {
      job.error = "Command timed out"; this.kill(job, "SIGTERM"); job.killTimer = setTimeout(() => this.kill(job, "SIGKILL"), 3000); job.killTimer.unref();
    }, a.timeout * 1000) : undefined;
    timer?.unref();
    child.on("close", code => { closeSync(fd); job.done = true; job.code = code; job.finished = Date.now(); if (timer) clearTimeout(timer); if (job.killTimer) clearTimeout(job.killTimer); done(); });
    return this.poll(id, a.yield_ms ?? 10000, signal);
  }
  private async poll(id: string, wait: number, signal?: AbortSignal): Promise<unknown> {
    const job = this.job(id);
    if (!job.done && wait > 0) await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { finish(); reject(signal?.reason ?? new Error("cancelled")); };
      const timer = setTimeout(finish, wait); signal?.addEventListener("abort", abort, { once: true }); void job.settle.then(finish);
    });
    signal?.throwIfAborted();
    const start = job.offset, end = job.bytes; job.offset = end;
    const handle = await open(job.file, "r");
    let output: string;
    try {
      const bytes = Buffer.alloc(Math.min(end - start, PREVIEW));
      await handle.read(bytes, 0, bytes.length, start); output = bytes.toString("utf8");
    } finally { await handle.close(); }
    return { process: id, running: !job.done, exit_code: job.code, output, path: job.file, truncated: end - start > PREVIEW, ...(job.error ? { error: job.error } : {}) };
  }
  async close(): Promise<void> {
    for (const job of this.jobs.values()) if (!job.done) this.kill(job, "SIGKILL");
    await Promise.all([...this.jobs.values()].map(j => j.settle));
  }
}

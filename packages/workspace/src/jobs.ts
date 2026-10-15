import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WordError } from "../../sdk/src/message";

/** Most output one poll returns; the rest stays in the output file and comes with the next poll. */
const POLL_BYTES = 50 * 1024;
const MAX_RUNNING = 16;
const KEEP_FINISHED_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;

/**
 * Where a command runs: `cwd` is the directory as the shell will see it, `hostCwd` the same directory on this machine
 * (they differ when the shell lives in a container with its own root).
 */
export interface CommandPlace { cwd: string; hostCwd: string }
/**
 * Starts `command` (a shell command line) and returns the child, with piped stdout and stderr. Start it in its own
 * process group (`detached: true`) so that signals reach everything it started. `env` is added to its environment.
 */
export type Executor = (command: string, place: CommandPlace, env?: Record<string, string>) => ChildProcess;

/** The default: `bash -lc` on this machine. */
export const hostExecutor: Executor = (command, place, env) =>
  spawn("bash", ["-lc", command], { cwd: place.hostCwd, detached: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });

export interface JobSnapshot {
  process: string;
  running: boolean;
  exit_code: number | null;
  output: string;
  /** The file (on this machine) all output so far is saved in. */
  file: string;
  /** More output waits in the file for the next poll. */
  truncated: boolean;
  error?: string;
}

interface Job {
  id: string;
  child: ChildProcess;
  file: string;
  decoder: StringDecoder;
  bytes: number;
  read: number;
  done: boolean;
  code: number | null;
  error?: string;
  finished?: number;
  settle: Promise<void>;
  /** Called when output arrives. */
  onData: Set<() => void>;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** Long commands: output is saved to a file as it comes, so it can be read in pieces; a command outlives the call that started it. */
export class Jobs {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly exec: Executor, private readonly spillDir: () => Promise<string>) {}

  get running(): number { return [...this.jobs.values()].filter((job) => !job.done).length; }

  async start(command: string, place: CommandPlace, opts: { timeout?: number; yield_ms: number; env?: Record<string, string> }, signal?: AbortSignal): Promise<JobSnapshot> {
    if (this.running >= MAX_RUNNING) throw new WordError("unavailable", `At most ${MAX_RUNNING} commands may run at once`);
    const folder = await this.spillDir();
    signal?.throwIfAborted();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const file = join(folder, `${id}.txt`);
    const fd = openSync(file, "wx", 0o600);
    let child: ChildProcess;
    try { child = this.exec(command, place, opts.env); } catch (error) {
      closeSync(fd);
      throw new WordError("failed", error instanceof Error ? error.message : String(error));
    }
    let finish!: () => void;
    const job: Job = { id, child, file, decoder: new StringDecoder("utf8"), bytes: 0, read: 0, done: false, code: null, settle: new Promise<void>((resolve) => { finish = resolve; }), onData: new Set() };
    this.jobs.set(id, job);
    let closed = false;
    const append = (data: Buffer) => {
      if (closed) return;
      try { writeSync(fd, data); job.bytes += data.length; for (const wake of [...job.onData]) wake(); } catch { job.error = "Cannot save command output"; this.kill(job, "SIGKILL"); }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = opts.timeout ? setTimeout(() => {
      job.error = "Command timed out";
      this.kill(job, "SIGTERM");
      job.killTimer = setTimeout(() => this.kill(job, "SIGKILL"), KILL_GRACE_MS);
      job.killTimer.unref();
    }, opts.timeout * 1000) : undefined;
    timer?.unref();
    const end = (code: number | null) => {
      if (job.done) return;
      job.done = true;
      job.code = code;
      job.finished = Date.now();
      closed = true;
      closeSync(fd);
      if (timer) clearTimeout(timer);
      if (job.killTimer) clearTimeout(job.killTimer);
      finish();
    };
    child.on("error", (error) => { job.error = error.message; });
    // 'close' follows 'error' for a command that could not start; stdio is drained before 'close'.
    child.on("close", (code) => end(code));
    return this.poll(id, opts.yield_ms, signal, false);
  }

  private get(id: string): Job {
    for (const [key, job] of this.jobs) if (job.finished && Date.now() - job.finished > KEEP_FINISHED_MS) this.jobs.delete(key);
    const job = this.jobs.get(id);
    if (!job) throw new WordError("not_found", "No such process; it may have finished long ago. Do not rerun it without checking what it already did");
    return job;
  }

  private kill(job: Job, signal: NodeJS.Signals): void {
    const pid = job.child.pid;
    if (!pid) return;
    try { process.kill(-pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      try { job.child.kill(signal); } catch { /* already gone */ }
    }
  }

  /** Waits up to `waitMs` for the command to end or (with `early`) for new output, then returns what is new. */
  async poll(id: string, waitMs: number, signal?: AbortSignal, early = true): Promise<JobSnapshot> {
    const job = this.get(id);
    signal?.throwIfAborted();
    if (!job.done && waitMs > 0 && job.read >= job.bytes) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); job.onData.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); job.onData.delete(done); reject(signal?.reason ?? new WordError("cancelled", "The call was cancelled")); };
        const timer = setTimeout(done, waitMs);
        if (early) job.onData.add(done);
        signal?.addEventListener("abort", abort, { once: true });
        void job.settle.then(done);
      });
    }
    signal?.throwIfAborted();
    const start = job.read;
    const length = Math.min(job.bytes - start, POLL_BYTES);
    job.read = start + length;
    let output = "";
    if (length > 0) {
      const handle = await open(job.file, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        output = job.decoder.write(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
    }
    const truncated = job.read < job.bytes;
    if (job.done && !truncated) output += job.decoder.end();
    return { process: id, running: !job.done, exit_code: job.code, output, file: job.file, truncated, ...(job.error ? { error: job.error } : {}) };
  }

  signal(id: string, signal: "INT" | "TERM"): { process: string; signalled: boolean } {
    const job = this.get(id);
    if (job.done) return { process: id, signalled: false };
    this.kill(job, signal === "INT" ? "SIGINT" : "SIGTERM");
    return { process: id, signalled: true };
  }

  /** Stops everything still running. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) if (!job.done) this.kill(job, "SIGKILL");
    await Promise.all([...this.jobs.values()].map((job) => job.settle));
  }
}

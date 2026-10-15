/**
 * The body contract (SPEC-09 §2) on a Node file system and shell: `workspace.ls/read/find/grep/write/edit/bash/poll/signal`
 * and `body.info`. Names, inputs and results are the standard actions of the sdk (namespaces.ts); nothing is redefined here.
 *
 * One `Workspace` serves one root directory. It knows nothing about phones, containers or connections: where a command
 * runs is the `exec` function it is given, and how a big file travels is the `streams` function it is given.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, stat, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ContentPart } from "../../sdk/src/link";
import { WordError, type WordResult } from "../../sdk/src/message";
import { STANDARD_NAMESPACES, standardAction } from "../../sdk/src/namespaces";
import { compileSchema, type Risk } from "../../sdk/src/word";
import { asWorkspaceError } from "./errors";
import { globToRegExp } from "./glob";
import { describeBody } from "./info";
import { isWithin, Jail } from "./jail";
import { hostExecutor, Jobs, type Executor, type JobSnapshot } from "./jobs";

export type { CommandPlace, Executor } from "./jobs";

/** A file `workspace.write` and `workspace.edit` may hold, and the longest text `workspace.read` returns inline. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** The largest file `workspace.read` hands over as a stream. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const MAX_WALK = 200_000;

/** The actions a workspace serves: the standard `workspace.*` and `body.info` (sdk namespaces). */
const ACTIONS = [...STANDARD_NAMESPACES.workspace!, ...STANDARD_NAMESPACES.body!].map((action) => action.name);

/**
 * Sends bytes to the caller as a stream and returns the stream id the result refers to
 * (`{type: "resource", stream, mime, size}`, SPEC-03 §3.4). On a hand this is the link client's `sendStream`; on the hub's own body it
 * is the channel the call came in through (a `streams` of the call).
 */
export type StreamPublisher = (data: Uint8Array, meta: { mime: string }) => string | Promise<string>;

/** What a call returns: the structured `data` of the standard action, and the `content` parts (the shape of a link `result` frame). */
export interface CallOutcome extends WordResult { data: Record<string, unknown>; content: ContentPart[] }

export interface WorkspaceOptions {
  /** The directory every path stays under. */
  root: string;
  /** Show root-based paths (the root is "/"); for a root file system that is not this machine's own. Default false. */
  chroot?: boolean;
  /** Chroot only: host directories that appear inside the root at another place (a container's bind mounts). */
  mounts?: { guest: string; host: string }[];
  /** The work directory, as shown (default: the root). Relative paths start here; a write inside it needs no approval. */
  workdir?: string;
  /** Starts a command. Default: `bash -lc` on this machine. */
  exec?: Executor;
  /** Where command output is saved (a host directory). Default: a fresh temporary directory, made on first use. */
  spillDir?: string;
  /** How a binary or large file is sent, unless the call brings its own. Without either such a file cannot be read (`unavailable`). */
  streams?: StreamPublisher;
  /** Reported by `body.info`. Default "borrowed". */
  ownership?: "own" | "borrowed";
  /** Host directories a work directory may not hold or be inside to count as "free to write" (e.g. the home folder). */
  guard?: string[];
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };
const json = (data: Record<string, unknown>): ContentPart[] => [{ type: "text", text: JSON.stringify(data) }];

type Args = Record<string, any>;

export class Workspace {
  private readonly jail: Jail;
  private readonly workdir: string;
  private readonly ownership: "own" | "borrowed";
  private readonly jobs: Jobs;
  private readonly validators = new Map<string, ReturnType<typeof compileSchema>>();
  private spill: Promise<string> | null = null;

  constructor(private readonly o: WorkspaceOptions) {
    this.jail = new Jail(o.root, o.chroot ?? false, o.mounts);
    this.workdir = o.workdir ?? this.jail.shownRoot;
    this.ownership = o.ownership ?? "borrowed";
    this.jobs = new Jobs(o.exec ?? hostExecutor, () => this.spillDirectory());
    for (const name of ACTIONS) this.validators.set(name, compileSchema(standardAction(name)!.input_schema));
  }

  /** Runs one standard action. Failures are thrown as the sdk's `WordError`. */
  async call(name: string, args: Args, opts: { signal?: AbortSignal; streams?: StreamPublisher } = {}): Promise<CallOutcome> {
    const validate = this.validators.get(name);
    if (!validate) throw new WordError("not_found", `No such action: ${name}`);
    if (!validate(args)) {
      const first = validate.errors?.[0];
      throw new WordError("bad_request", `Input does not match ${name}: ${first ? `${first.instancePath || "input"} ${first.message}` : "invalid"}`);
    }
    try {
      opts.signal?.throwIfAborted();
      return await this.run(name, args, opts.signal, opts.streams ?? this.o.streams);
    } catch (error) {
      throw asWorkspaceError(error, opts.signal);
    }
  }

  /**
   * The risk of one `workspace.write` or `workspace.edit` call (SPEC-01 §6.3): a write that lands inside the work
   * directory changes only that folder (none); everywhere else the declared risk stands. Other actions: the declared risk.
   */
  async assess(name: string, args: Args): Promise<Risk> {
    const declared = standardAction(name)?.risk ?? "structure";
    if (name !== "workspace.write" && name !== "workspace.edit") return declared;
    const validate = this.validators.get(name);
    if (!validate?.(args)) return declared;
    try {
      const work = await this.jail.resolve(args.workdir ?? ".", this.workdir);
      const target = await this.jail.resolve(args.path, this.shownDir(work));
      return await this.freeToWrite(target) ? "none" : declared;
    } catch { return declared; }
  }

  /** A command started by `workspace.bash` is still running. */
  get busy(): boolean { return this.jobs.running > 0; }

  async close(): Promise<void> { await this.jobs.close(); }

  // --- paths ---

  private shownDir(host: string): string { return this.jail.show(host) ?? this.workdir; }

  private async cwd(args: Args): Promise<string> {
    const host = await this.jail.resolve(args.workdir ?? ".", this.workdir);
    return host;
  }
  private async target(args: Args, cwd: string, fallback = "."): Promise<string> {
    return this.jail.resolve(args.path ?? fallback, this.shownDir(cwd));
  }
  private show(host: string): string { return this.jail.show(host) ?? host; }

  private async freeToWrite(target: string): Promise<boolean> {
    const work = await this.jail.resolve(".", this.workdir);
    const root = await realpath(work).catch(() => null);
    if (!root) return false;
    for (const guarded of this.o.guard ?? []) if (isWithin(root, await realpath(guarded).catch(() => guarded))) return false;
    // The target may not exist yet: take the real path of the nearest folder that does.
    let existing = target, tail = "";
    for (;;) {
      const real = await realpath(existing).catch(() => null);
      if (real) { existing = join(real, tail); break; }
      const parent = dirname(existing);
      if (parent === existing) return false;
      tail = join(basename(existing), tail);
      existing = parent;
    }
    return existing !== root && isWithin(root, existing);
  }

  private spillDirectory(): Promise<string> {
    this.spill ??= this.o.spillDir ? Promise.resolve(this.o.spillDir) : mkdtemp(join(tmpdir(), "ash-workspace-"));
    return this.spill;
  }

  // --- actions ---

  private async run(name: string, a: Args, signal?: AbortSignal, streams?: StreamPublisher): Promise<CallOutcome> {
    switch (name) {
      case "body.info": {
        const data = await describeBody(this.jail, this.workdir, this.ownership);
        return { data, content: json(data) };
      }
      case "workspace.poll": return this.job(await this.jobs.poll(a.process, a.yield_ms ?? 1000, signal));
      case "workspace.signal": {
        const data = this.jobs.signal(a.process, a.signal);
        return { data, content: json(data) };
      }
    }
    const cwd = await this.cwd(a);
    switch (name) {
      case "workspace.bash": {
        const info = await stat(cwd).catch((error) => { throw asWorkspaceError(error); });
        if (!info.isDirectory()) throw new WordError("bad_request", "The working directory is not a directory");
        return this.job(await this.jobs.start(a.command, { cwd: this.shownDir(cwd), hostCwd: cwd }, { timeout: a.timeout, yield_ms: a.yield_ms ?? 10000, ...(a.env ? { env: a.env } : {}) }, signal));
      }
      case "workspace.ls": return this.ls(await this.target(a, cwd), a.limit ?? 1000);
      case "workspace.read": return this.read(await this.target(a, cwd), a, signal, streams);
      case "workspace.find": return this.find(await this.target(a, cwd), a.pattern, a.limit ?? 1000, signal);
      case "workspace.grep": return this.grep(await this.target(a, cwd), a, signal);
      case "workspace.write": return this.write(await this.target(a, cwd), a.content);
      case "workspace.edit": return this.edit(await this.target(a, cwd), a.edits);
      default: throw new WordError("not_found", `This workspace does not serve ${name}`);
    }
  }

  private job(snapshot: JobSnapshot): CallOutcome {
    const file = this.jail.show(snapshot.file) ?? (this.jail.chroot ? undefined : snapshot.file);
    const data: Record<string, unknown> = {
      process: snapshot.process, running: snapshot.running, exit_code: snapshot.exit_code, output: snapshot.output,
      ...(file ? { path: file } : {}), truncated: snapshot.truncated, ...(snapshot.error ? { error: snapshot.error } : {}),
    };
    return { data, content: [{ type: "text", text: snapshot.output || JSON.stringify(data) }] };
  }

  private async ls(dir: string, limit: number): Promise<CallOutcome> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const shown = await Promise.all(entries.slice(0, limit).map(async (entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
      size: (await lstat(join(dir, entry.name)).catch(() => null))?.size ?? null,
    })));
    const data = { path: this.show(dir), truncated: entries.length > limit, entries: shown };
    return { data, content: json(data) };
  }

  private async read(file: string, a: Args, signal?: AbortSignal, streams?: StreamPublisher): Promise<CallOutcome> {
    const info = await stat(file);
    if (info.isDirectory()) throw new WordError("bad_request", "That is a directory; use workspace.ls");
    const explicitRange = a.offset !== undefined || a.limit !== undefined;
    if (await this.isBinary(file, info.size) || (info.size > MAX_TEXT_BYTES && !explicitRange)) return this.stream(file, info.size, streams);
    const offset: number = a.offset ?? 1, limit: number = a.limit ?? 2000;
    const source = createReadStream(file, { signal });
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let failure: Error | undefined;
    source.on("error", (error) => { failure = error; lines.close(); });
    const out: string[] = [];
    let n = 0, bytes = 0, truncated = false;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        n++;
        if (n < offset) continue;
        const size = Buffer.byteLength(line);
        if (size > MAX_TEXT_BYTES && out.length === 0) throw new WordError("too_large", "A single line exceeds 4 MiB; use workspace.grep or workspace.bash to read a smaller part");
        if (out.length >= limit || bytes + size > MAX_TEXT_BYTES) { truncated = true; break; }
        out.push(line);
        bytes += size + 1;
      }
      if (failure) throw failure;
    } finally { lines.close(); source.destroy(); }
    const text = out.join("\n");
    const data = { path: this.show(file), text, offset, next_offset: offset + out.length, truncated };
    return { data, content: [{ type: "text", text }] };
  }

  private async isBinary(file: string, size: number): Promise<boolean> {
    if (IMAGE_TYPES[extname(file).toLowerCase()]) return true;
    if (size === 0) return false;
    const handle = await open(file, "r");
    try {
      const head = Buffer.alloc(Math.min(size, SNIFF_BYTES));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return head.subarray(0, bytesRead).includes(0);
    } finally { await handle.close(); }
  }

  private async stream(file: string, size: number, streams?: StreamPublisher): Promise<CallOutcome> {
    if (!streams) throw new WordError("unavailable", "This body cannot send a binary or large file: no stream is available");
    if (size > MAX_STREAM_BYTES) throw new WordError("too_large", `The file is ${size} bytes; at most ${MAX_STREAM_BYTES} can be sent`);
    const mime = IMAGE_TYPES[extname(file).toLowerCase()] ?? ((await this.isBinary(file, size)) ? "application/octet-stream" : "text/plain");
    const bytes = await readFile(file);
    const sid = await streams(bytes, { mime });
    const data = { path: this.show(file), size: bytes.length, mime, stream: sid };
    return { data, content: [{ type: "text", text: `${this.show(file)} is ${mime}, ${bytes.length} bytes: sent as a stream` }, { type: "resource", stream: sid, mime, size: bytes.length }] };
  }

  private async write(file: string, content: string): Promise<CallOutcome> {
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_TEXT_BYTES) throw new WordError("too_large", "A file written in one call may be at most 4 MiB");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    const data = { path: this.show(file), bytes };
    return { data, content: json(data) };
  }

  private async edit(file: string, edits: { oldText: string; newText: string }[]): Promise<CallOutcome> {
    const real = await realpath(file);
    const info = await stat(real);
    if (info.size > MAX_TEXT_BYTES) throw new WordError("too_large", "A file larger than 4 MiB cannot be edited");
    let text = await readFile(real, "utf8");
    edits.forEach(({ oldText, newText }, index) => {
      const at = text.indexOf(oldText);
      if (at < 0) throw new WordError("bad_request", `edits[${index}].oldText was not found; nothing was saved`);
      if (text.indexOf(oldText, at + 1) >= 0) throw new WordError("bad_request", `edits[${index}].oldText matches more than once; add context so it matches exactly once; nothing was saved`);
      text = text.slice(0, at) + newText + text.slice(at + oldText.length);
    });
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new WordError("too_large", "The edited file would exceed 4 MiB; nothing was saved");
    const temp = `${real}.ash-${randomUUID()}`;
    await writeFile(temp, text, { mode: info.mode & 0o777 });
    await rename(temp, real);
    const data = { path: this.show(file), edits: edits.length };
    return { data, content: json(data) };
  }

  /** Visits the files and folders under `dir` (not through links), in name order. `visit` returns false to stop. */
  private async walk(dir: string, signal: AbortSignal | undefined, visit: (host: string, rel: string, isDir: boolean) => boolean | Promise<boolean>): Promise<boolean> {
    let seen = 0;
    const go = async (current: string, rel: string): Promise<boolean> => {
      const entries = (await readdir(current, { withFileTypes: true }).catch(() => [])).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (++seen > MAX_WALK) return false;
        const host = join(current, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
        const isDir = entry.isDirectory();
        if (!(await visit(host, name, isDir))) return false;
        if (isDir && !(await go(host, name))) return false;
      }
      return true;
    };
    return go(dir, "");
  }

  private async find(dir: string, pattern: string, limit: number, signal?: AbortSignal): Promise<CallOutcome> {
    if ((await stat(dir)).isDirectory() === false) throw new WordError("bad_request", "The search path is not a directory");
    const matcher = globToRegExp(pattern.replace(/^\.\//, ""));
    const paths: string[] = [];
    let truncated = false;
    const finished = await this.walk(dir, signal, (host, rel) => {
      if (!matcher.test(rel)) return true;
      if (paths.length >= limit) { truncated = true; return false; }
      paths.push(this.show(host));
      return true;
    });
    const data = { paths, truncated: truncated || !finished };
    return { data, content: json(data) };
  }

  private async grep(target: string, a: Args, signal?: AbortSignal): Promise<CallOutcome> {
    const info = await stat(target);
    let regex: RegExp;
    try {
      regex = new RegExp(a.literal ? String(a.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern, a.ignoreCase ? "i" : "");
    } catch (error) { throw new WordError("bad_request", `The pattern is not a valid regular expression: ${(error as Error).message}`); }
    const glob = a.glob ? globToRegExp(a.glob) : null;
    const context: number = a.context ?? 0, limit: number = a.limit ?? 100;
    const matches: { path: string; line: number; text: string; context: boolean }[] = [];
    let truncated = false;
    const search = async (host: string, rel: string): Promise<boolean> => {
      if (glob && !glob.test(rel) && !(!a.glob.includes("/") && glob.test(basename(rel)))) return true;
      // A link met while walking is not followed; a file named by the caller was already resolved.
      const entry = await lstat(host).catch(() => null);
      if (!entry?.isFile() || entry.size > MAX_TEXT_BYTES || await this.isBinary(host, entry.size)) return true;
      const rows = (await readFile(host, "utf8")).split(/\r?\n/);
      const picked = new Set<number>();
      for (let i = 0; i < rows.length; i++) {
        if (!regex.test(rows[i]!)) continue;
        for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
          if (picked.has(j)) continue;
          picked.add(j);
          if (matches.length >= limit) { truncated = true; return false; }
          matches.push({ path: this.show(host), line: j + 1, text: rows[j]!.slice(0, 2000), context: j !== i });
        }
      }
      return true;
    };
    if (info.isDirectory()) {
      let stop = false;
      const finished = await this.walk(target, signal, async (host, rel, isDir) => {
        if (stop) return false;
        if (!isDir && !(await search(host, rel))) { stop = true; return false; }
        return true;
      });
      truncated = truncated || !finished && !stop;
    } else await search(target, basename(target));
    const data = { matches, truncated };
    return { data, content: json(data) };
  }
}


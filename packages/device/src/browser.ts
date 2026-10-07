import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CapabilitySpec, CallResult } from "../../sdk/src/api";
import { redactText } from "./redact";
const exec = promisify(execFile);
export const EGO_CAPABILITY: CapabilitySpec & { effect: "act"; label: string } = {
  name: "browser.script", label: "在电脑浏览器执行任务脚本", effect: "act", risk: "structure",
  description: "Run JavaScript with ego-browser. A persistent task space is supplied as `task`; use task.page('p1'), goto, snapshot, click, fill. Give a distinct task name per job, reuse it to continue. Only use this space's pages, never adopt user tabs. Log results with console.log. Set finish=true after the task to close its tabs. This runs local JavaScript with the computer account's authority, not a read-only browser query.",
  input_schema: { type: "object", additionalProperties: false, required: ["task", "script"], properties: {
    task: { type: "string", minLength: 1, maxLength: 120 }, script: { type: "string", maxLength: 100000 }, finish: { type: "boolean" },
  } },
};
export async function detectEgo(): Promise<string | undefined> {
  for (const file of [...(process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "ego-browser")), join(homedir(), ".local/bin/ego-browser")]) {
    try { await access(file, constants.X_OK); return file; } catch { /* not installed */ }
  }
}
type Run = (script: string, signal?: AbortSignal) => Promise<string>;
/** Reuses the browser's own task spaces. Local script execution is explicitly an approved act. */
export class Browser {
  private spaces: Record<string, number> = {};
  private busy = new Set<string>();
  private loaded?: Promise<void>;
  constructor(private readonly stateDir: string, private readonly command: string, private readonly run: Run = async (script, signal) => {
    const child = exec(command, ["nodejs", "-e", script], { signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    child.child.stdin?.end();
    const result = await child;
    // ego-browser forwards script console output on stderr as well as stdout.
    return result.stdout + result.stderr;
  }) {}
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      try { this.spaces = JSON.parse(await readFile(join(this.stateDir, "browser-spaces.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    })(); await this.loaded;
  }
  private async save(): Promise<void> {
    const file = join(this.stateDir, "browser-spaces.json"), temp = file + "." + randomUUID();
    await writeFile(temp, JSON.stringify(this.spaces), { mode: 0o600 }); await rename(temp, file);
  }
  async call(args: Record<string, unknown>, caller: string, signal?: AbortSignal): Promise<CallResult> {
    if (typeof args.task !== "string" || !args.task || args.task.length > 120 || typeof args.script !== "string" || args.script.length > 100000 ||
      Object.keys(args).some(key => !["task", "script", "finish"].includes(key)) || (args.finish !== undefined && typeof args.finish !== "boolean"))
      return { ok: false, error: "Invalid browser script arguments", content: [] };
    const key = JSON.stringify([caller, args.task]);
    if (this.busy.size) return { ok: false, error: "A browser script is already running; wait for its result", content: [] };
    this.busy.add(key);
    try {
      signal?.throwIfAborted(); await this.load();
      if (!this.spaces[key]) {
        const marker = `ash-space-${randomUUID()}:`;
        const output = await this.run(`const task = await taskSpace(${JSON.stringify(`Ash · ${caller} · ${args.task} · ${randomUUID().slice(0, 8)}`)}); console.log(${JSON.stringify(marker)} + task.spaceId);`, signal);
        const id = Number(output.split("\n").find(line => line.startsWith(marker))?.slice(marker.length));
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Browser did not return a task space");
        this.spaces[key] = id; await this.save();
      }
      const output = await this.run(`const task = await taskSpace(${this.spaces[key]});\n${args.script}\n${args.finish ? "await task.finish({keep:[]});" : ""}`, signal);
      if (args.finish) { delete this.spaces[key]; await this.save(); }
      const text = redactText(output);
      let data: unknown = { text };
      if (Buffer.byteLength(text) > 50000) {
        const path = join(this.stateDir, `browser-result-${randomUUID()}.txt`); await writeFile(path, text, { mode: 0o600 });
        data = { path, preview: text.slice(0, 12000), truncated: true };
      }
      return { ok: true, data, content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (error) {
      // exec errors include the source script and can contain credentials: do not echo them.
      return { ok: false, content: [], error: signal?.aborted ? "Browser task cancelled; inspect its space before continuing" : "Browser script failed; inspect the task space before retrying actions" };
    } finally { this.busy.delete(key); }
  }
  get running(): boolean { return this.busy.size > 0; }
}

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Message } from "../../sdk/src/api";
import type { AgentTurnInput, AgentTurnOutput, AgentTurnRunner } from "../../core/src/members/agent";
import type { DoorTurnAdapter, DshRootAgent, DshSessionEvent } from "./host";
import type { DshDoor } from "./door";
import { DshHost } from "./host";

const IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4096;
const MAX_PREFIX_BYTES = 512;
const TOTAL_TEXT_BYTES = 32 * 1024;
const MAX_ATTACHMENTS = 32;
const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); };

function decodeData(value: string): Buffer {
  if (!BASE64.test(value)) throw new TypeError("invalid attachment base64");
  const data = Buffer.from(value, "base64");
  if (data.length > MAX_ATTACHMENT_BYTES || data.toString("base64") !== value) throw new TypeError("invalid attachment size or base64");
  return data;
}

function validImage(mime: string, data: Buffer): boolean {
  if (mime === "image/png") return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/jpeg") return data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  if (mime === "image/gif") return data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mime === "image/webp") return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/** Atomic, idempotent materialization; supplied filenames never determine the target. */
export function materializeFile(root: string, id: string, index: number, data: Buffer): { path: string; hash: string } {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(index) || index < 0) throw new TypeError("invalid attachment identity");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(root)).isSymbolicLink()) throw new Error("attachment parent is not a safe directory");
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("attachment root is not a safe directory");
  const directory = realpathSync(root);
  const hash = createHash("sha256").update(data).digest("hex");
  const path = join(directory, `${id}-${index}-${hash}`);
  const claim = join(directory, `${id}-${index}.claim`);
  const temp = join(directory, `.tmp-${randomUUID()}`);
  try {
    const descriptor = openSync(temp, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < data.length) offset += writeSync(descriptor, data, offset, data.length - offset);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { linkSync(temp, claim); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(claim);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length ||
        createHash("sha256").update(readFileSync(claim)).digest("hex") !== hash) throw new Error("existing attachment differs");
    }
    try { linkSync(claim, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length ||
        createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) throw new Error("existing attachment differs");
    }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  return { path, hash };
}

/** Separate conversational paragraphs, never a fenced code block. */
export function splitAssistantText(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [];
  let fence: string | null = null;
  const flush = () => { const value = lines.join("\n").trim(); if (value) parts.push(value); lines = []; };
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker) fence = marker[0];
    else if (fence && marker && marker[0] === fence && marker.length >= 3) fence = null;
    if (!fence && !line.trim()) flush();
    else lines.push(line);
  }
  flush();
  return parts;
}

function attachmentRows(messages: readonly Message[]): { id: string; index: number; name: string; mime: string; data?: string; path?: string; workspace?: string }[] {
  const rows: ReturnType<typeof attachmentRows> = [];
  for (const message of messages) {
    const attachments = message.body.attachments;
    if (!Array.isArray(attachments)) continue;
    attachments.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid attachment");
      const item = raw as Record<string, unknown>;
      if (typeof item.name !== "string" || item.name.length > 255 || typeof item.mime_type !== "string" || item.mime_type.length > 128 || !MIME.test(item.mime_type)) throw new TypeError("invalid attachment metadata");
      if (typeof item.data === "string") rows.push({ id: message.id, index, name: item.name, mime: item.mime_type, data: item.data });
      else if (typeof item.path === "string" && typeof item.workspace === "string") rows.push({ id: message.id, index, name: item.name, mime: item.mime_type, path: item.path, workspace: item.workspace });
      else throw new TypeError("attachment has no source");
    });
  }
  return rows;
}

/** Only the already-budgeted rendered text and bounded attachment references enter DSH. */
export async function turnContent(host: DshHost, input: AgentTurnInput, attachmentRoot: string, workspaceRoot: string): Promise<unknown[]> {
  const last = input.messages.at(-1);
  const source = last?.origin && typeof last.origin === "object" && typeof last.origin.label === "string" ? last.origin.label : last?.from ?? "unknown";
  const safeSource = [...source.replace(/[\x00-\x1f\x7f]/g, " ")].slice(0, 120).join("");
  const prefix = `[ash] ${last ? new Date(last.ts).toISOString() : new Date().toISOString()} · ${safeSource}\n`;
  if (Buffer.byteLength(prefix) > MAX_PREFIX_BYTES) throw new Error("turn source prefix exceeds its budget");
  const content: unknown[] = [{ type: "text", text: `${prefix}${input.rendered}` }];
  const rows = attachmentRows(input.messages);
  if (rows.length > MAX_ATTACHMENTS) throw new Error("too many attachments for one turn");
  let totalBytes = 0;
  const estimatedRefs = rows.map((row) => {
    if (row.data !== undefined) {
      if (!BASE64.test(row.data)) throw new TypeError("invalid attachment base64");
      const size = row.data.length * 3 / 4 - (row.data.endsWith("==") ? 2 : row.data.endsWith("=") ? 1 : 0);
      if (size > MAX_ATTACHMENT_BYTES) throw new Error("attachment exceeds size limit");
      totalBytes += size;
    }
    const base = `${IMAGE.has(row.mime) ? "image" : "attachment"} source id=${row.id} index=${row.index} name=${JSON.stringify(row.name)} type=${row.mime}`;
    const hash = "0".repeat(64);
    if (IMAGE.has(row.mime)) return `[${base} sha256=${hash}${row.path ? ` workspace=${JSON.stringify(row.workspace)} path=${JSON.stringify(row.path)}` : ""}]`;
    return `[${base}${row.data !== undefined ? ` sha256=${hash} path=${JSON.stringify(join(resolve(attachmentRoot), `${row.id}-${row.index}-${hash}`))}` :
      ` workspace=${JSON.stringify(row.workspace)} path=${JSON.stringify(row.path)}`}]`;
  }).join("\n");
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES || Buffer.byteLength(estimatedRefs) > MAX_SOURCE_BYTES ||
    Buffer.byteLength(prefix + input.rendered + estimatedRefs) > TOTAL_TEXT_BYTES) throw new Error("attachment batch exceeds its budget");
  const refs: string[] = [];
  const store = host.ctx?.get("attachments");
  for (const row of rows) {
    if (IMAGE.has(row.mime)) {
      let data: Buffer;
      if (row.data !== undefined) data = decodeData(row.data);
      else {
        if (!row.path || row.workspace !== "home") throw new Error("image reference is not in the configured workspace");
        const root = realpathSync(workspaceRoot);
        const target = realpathSync(join(root, row.path));
        if (!inside(root, target)) throw new Error("image reference escapes its workspace");
        if (statSync(target).size > MAX_ATTACHMENT_BYTES) throw new Error("image attachment exceeds size limit");
        data = readFileSync(target);
      }
      if (data.length > MAX_ATTACHMENT_BYTES || !validImage(row.mime, data) || !store?.saveImage) throw new Error("image attachment cannot be safely loaded");
      const ref = await store.saveImage({ data: new Uint8Array(data), mediaType: row.mime, name: row.name });
      content.push({ type: "image", attachment: ref });
      refs.push(`[image source id=${row.id} index=${row.index} name=${JSON.stringify(row.name)} type=${row.mime} sha256=${createHash("sha256").update(data).digest("hex")}` +
        (row.path ? ` workspace=${JSON.stringify(row.workspace)} path=${JSON.stringify(row.path)}` : "") + "]");
    } else {
      const stored = row.data === undefined ? null : materializeFile(attachmentRoot, row.id, row.index, decodeData(row.data));
      refs.push(`[attachment source id=${row.id} index=${row.index} name=${JSON.stringify(row.name)} type=${row.mime}` +
        (stored ? ` sha256=${stored.hash} path=${JSON.stringify(stored.path)}` : ` workspace=${JSON.stringify(row.workspace)} path=${JSON.stringify(row.path)}`) + "]");
    }
  }
  const note = refs.join("\n");
  if (Buffer.byteLength(note, "utf8") > MAX_SOURCE_BYTES) throw new Error("attachment source metadata exceeds the turn budget");
  if (Buffer.byteLength(prefix + input.rendered + note, "utf8") > TOTAL_TEXT_BYTES) throw new Error("turn text and attachment references exceed the context budget");
  if (note) content.push({ type: "text", text: note });
  return content;
}

/** A single real DSH session; cancellation is not proof of idle. */
export class DshTurnRunner implements AgentTurnRunner, DoorTurnAdapter {
  renderBudgetBytes = TOTAL_TEXT_BYTES - MAX_SOURCE_BYTES - MAX_PREFIX_BYTES;
  private session: { agent: DshRootAgent; door: DshDoor; id: string } | null = null;
  private busy = false;
  constructor(private readonly host: DshHost, private readonly attachmentRoot: string, private readonly workspaceRoot: string) {}
  attach(agent: DshRootAgent, door: DshDoor, sessionId: string): void {
    if (this.session) throw new Error("runner already attached");
    this.session = { agent, door, id: sessionId };
  }
  private async proveIdle(agent: DshRootAgent): Promise<void> {
    try { await agent.whenIdle(); }
    catch {
      // A rejected idle receipt is not proof that a non-cooperative tool stopped.
      // Keep the current run pending until process recovery rather than dispatching another batch.
      await new Promise<never>(() => {});
    }
  }
  async runTurn(input: AgentTurnInput, emit: (output: AgentTurnOutput) => Promise<void>, signal: AbortSignal): Promise<{ reason: "completed" | "error"; error?: string }> {
    const session = this.session;
    if (!session || this.busy) throw new Error("DSH session unavailable or still busy");
    if (signal.aborted) return { reason: "error", error: "turn cancelled before dispatch" };
    this.busy = true;
    const messageId = randomUUID();
    const seen = new Set<string>();
    let pending = Promise.resolve();
    let emitError: unknown;
    let finish!: (value: { reason: "completed" | "error"; error?: string }) => void;
    const ended = new Promise<{ reason: "completed" | "error"; error?: string }>((resolve) => { finish = resolve; });
    let mine = false;
    let settled = false;
    const settle = (value: { reason: "completed" | "error"; error?: string }) => {
      if (settled) return;
      settled = true;
      finish(value);
    };
    const onEvent = (sid: string, event: DshSessionEvent) => {
      if (sid !== session.id || settled) return;
      if (!mine) {
        if (event.type === "user/message" && event.data?.id === messageId) mine = true;
        return;
      }
      if (event.type === "assistant/message") {
        const message = event.data?.message;
        const id = typeof message?.id === "string" ? message.id : `unidentified-${seen.size}`;
        const text = Array.isArray(message?.content) ? message.content.filter((block: { type?: string }) => block.type === "text")
          .map((block: { text?: string }) => block.text ?? "").join("") : "";
        if (!text.trim()) return; // tool-only messages do not consume a text identity
        const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
        if (seen.has(key)) return;
        seen.add(key);
        for (const [index, part] of splitAssistantText(text).entries()) {
          pending = pending.then(() => signal.aborted || emitError ? undefined : emit({ id: `${key}:${index}`, text: part }))
            .catch((error) => { emitError ??= error; });
        }
      } else if (event.type === "turn/end") {
        const reason = event.data?.reason?.kind;
        settle(reason === "completed" ? { reason: "completed" } : { reason: "error", error: `DSH turn ${String(reason ?? "unknown")}` });
      }
    };
    const off = this.host.onSessionEvent(onEvent);
    const abort = () => { session.agent.cancel("turn cancelled"); settle({ reason: "error", error: "turn cancelled" }); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      session.door.beginTurn(input.turn, signal);
      const content = await turnContent(this.host, input, this.attachmentRoot, this.workspaceRoot);
      if (signal.aborted) return { reason: "error", error: "turn cancelled" };
      session.agent.followup({ id: messageId, role: "user", content, source: { kind: "user" } });
      const result = await ended;
      await this.proveIdle(session.agent); // never await inside a DSH event listener
      await pending;
      if (emitError) return { reason: "error", error: emitError instanceof Error ? emitError.message : "agent output failed" };
      return signal.aborted ? { reason: "error", error: "turn cancelled" } : result;
    } catch (error) {
      await this.proveIdle(session.agent);
      return { reason: "error", error: error instanceof Error ? error.message : "DSH turn failed" };
    } finally {
      signal.removeEventListener("abort", abort);
      off();
      session.door.endTurn(input.turn);
      this.busy = false;
    }
  }
}

/**
 * `ash-device mcp`: an MCP server on stdio for the Codex App. Codex starts it; it holds nothing. Every tool call goes to
 * the ash-device that is running on this computer (local.ts), which carries it to the hub on its own connection, so no
 * Ash turn is needed. The hub names the tools and judges the calls (edges/tools: `callAttached`); this file only passes
 * them on, and says plainly when ash-device is not there.
 */
import { createInterface } from "node:readline";

type Frame = Record<string, any>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

export interface McpBackend {
  /** One tool call, or `tools/list`; rejects with a message for the user when ash-device or the hub is not there. */
  call(tool: string, args: unknown, session: string | undefined): Promise<any>;
}

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
/** What `tools/list` says when ash-device is not running, so Codex still shows the tools; the calls then say what is wrong. */
export const FALLBACK_TOOLS: Tool[] = [
  { name: "capability_list", description: "Everything Ash can do, live: the phone and other devices, apps, services, with the words you may call.", inputSchema: object({ member: { type: "string" } }) },
  { name: "capability_describe", description: "The full contract of one member's words, or of one word.", inputSchema: object({ member: { type: "string" }, word: { type: "string" } }, ["member"]) },
  { name: "capability_call", description: "Call one word of one member with a body that matches its input_schema.", inputSchema: object({ member: { type: "string" }, word: { type: "string" }, body: { type: "object" }, wait: { type: "boolean" }, approval_ttl_minutes: { type: "integer" }, purpose: { type: "string" } }, ["member", "word"]) },
  { name: "await_result", description: "Wait for the result of an earlier call that returned status accepted.", inputSchema: object({ request_id: { type: "string" }, timeout_ms: { type: "integer" } }, ["request_id"]) },
  { name: "list_pending", description: "Your calls that have not finished yet.", inputSchema: object({}) },
  { name: "cancel", description: "Cancel one of your calls that has not finished.", inputSchema: object({ request_id: { type: "string" } }, ["request_id"]) },
  { name: "agent_list", description: "Ash's agents.", inputSchema: object({}) },
  { name: "agent_ask", description: "Ask one of Ash's agents and wait for the answer.", inputSchema: object({ agent: { type: "string" }, text: { type: "string" }, wait: { type: "boolean" } }, ["agent", "text"]) },
  { name: "agent_tell", description: "Tell one of Ash's agents something; no answer is waited for.", inputSchema: object({ agent: { type: "string" }, text: { type: "string" } }, ["agent", "text"]) },
];

/** The Codex session a tool call belongs to: `_meta["x-codex-turn-metadata"]` when Codex sends it, else the environment. */
export function sessionOf(params: Frame | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let meta = params?._meta?.["x-codex-turn-metadata"];
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = undefined; } }
  for (const key of ["session_id", "sessionId", "thread_id", "threadId"]) if (typeof meta?.[key] === "string" && meta[key]) return meta[key];
  return env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || undefined;
}

const failed = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

/** Answers one frame; undefined for a notification. */
export async function handleMcp(frame: Frame, backend: McpBackend, env: NodeJS.ProcessEnv = process.env): Promise<Frame | undefined> {
  if (!frame || typeof frame !== "object" || frame.id === undefined || typeof frame.method !== "string") return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
  switch (frame.method) {
    case "initialize": {
      const wanted = frame.params?.protocolVersion;
      return ok({ protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "ash", version: "0.1.0" } });
    }
    case "ping": return ok({});
    case "tools/list": {
      const reply = await backend.call("tools/list", {}, undefined).catch(() => null);
      return ok({ tools: Array.isArray(reply?.tools) && reply.tools.length ? reply.tools : FALLBACK_TOOLS });
    }
    case "tools/call": {
      const name = frame.params?.name;
      if (typeof name !== "string" || !name) return { jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "name is required" } };
      try { return ok(await backend.call(name, frame.params?.arguments ?? {}, sessionOf(frame.params, env))); }
      catch (error) { return ok(failed(String((error as Error)?.message ?? error))); }
    }
    case "resources/list": return ok({ resources: [] });
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "prompts/list": return ok({ prompts: [] });
    default: return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } };
  }
}

/** Newline-delimited JSON-RPC on the given streams until the input ends. Calls run side by side. */
export async function serveMcp(backend: McpBackend, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const open = new Set<Promise<void>>();
  const lines = createInterface({ input });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let frame: Frame;
    try { frame = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
    const job: Promise<void> = handleMcp(frame, backend).then((reply) => { if (reply) output.write(JSON.stringify(reply) + "\n"); }).finally(() => open.delete(job));
    open.add(job);
  }
  await Promise.all(open);
}

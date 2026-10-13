/**
 * The tool surface (HUB-MODULES §2.4, SPEC-02 §3): the one door for an agent, an MCP server on `/mcp`. A tool call
 * becomes `router.send` as the agent whose bearer token it carries, and in the turn of the lane that token was issued for;
 * nothing in the call can change either.
 *
 *   transport   Streamable HTTP (stateless), `Authorization: Bearer <token>`, no `Origin` header, calls only inside a turn
 *               (receipt tools excepted). The link server mounts `handler` at `/mcp`.
 *   tools       fixed tools = one word each; capability_list/describe/call; await_result/list_pending/cancel (tools.ts)
 *   receipts    a call that takes over 15 s answers `accepted` + `request_id`; a call the gate parks for the owner answers
 *               `waiting_owner` + `pending_id` (+ a `request_id`); both can be asked about later (jobs.ts)
 *   results     one envelope for success and failure (result.ts)
 *   come back   a receipt's answer that is still not fetched (await_result) when its turn is over is told to the agent once,
 *               as a `wake` {lane: "back", reason: "result", context: {request_id, member, word, label, outcome}}: at once if
 *               the turn is over when the answer comes, else when `turn.ended` is heard. `waiting_owner` is not told (its
 *               answer comes from service:gate). Calls a restart interrupted are told by `recover()` (result_unknown).
 *
 * Wiring: `agentPolicy` and `currentTurn` come from the agents module (the agent's declaration; the turn it is running on
 * a lane); the agents module calls `issueTokens` every time it starts an agent process and hands one token per lane to
 * the agent's driver, which gives each lane's session its own.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../../../sdk/src/versions";
import { errorBody, type Caller, type Reply } from "../../../../sdk/src/message";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";
import { capabilityDescribe, capabilityList, toolAllowed, type AgentPolicy, type CatalogRegistry } from "./catalog";
import { isWaitingOwner, JobTable, wakeOutcome, type JobRow } from "./jobs";
import { failure, plain, shapeError, shapeSuccess, type Attachment, type Shaped } from "./result";
import { ENVELOPE_APPROVAL, ENVELOPE_WAIT, fixedTool, RECEIPT_TOOLS, toolDefinitions, TOOL_NAMES, type WaitMode } from "./tools";

export { TOOL_NAMES, toolWords, toolDefinitions, FIXED_TOOLS, fixedTool } from "./tools";
export type { AgentPolicy } from "./catalog";
export type { Shaped } from "./result";

/**
 * All the tool surface needs of the router. `subscribe` is for `turn.ended` (a result that came while its turn was still
 * running is told to the agent when the turn ends); without it only results that arrive after the turn are told.
 */
export type ToolsRouter = Pick<Router, "send"> & Partial<Pick<Router, "subscribe">>;

export interface ToolsEdgeOptions {
  router: ToolsRouter;
  registry: CatalogRegistry;
  ledger: Pick<Ledger, "db" | "get">;
  /** The agent's declaration (its `tools` and `words`), or null when there is no such agent. Asked on every call. */
  agentPolicy(agentId: string): AgentPolicy | null;
  /** The turn the agent is running now on that lane, or null. Asked on every call. */
  currentTurn(agentId: string, lane: string): string | null;
  /** Whether that turn of the agent is still running, on any of its lanes (the lane a turn belongs to is not known to a result). */
  turnActive(agentId: string, turn: string): boolean;
  /** Callers of outside apps attached through a computer: they have no turns of their own, and are never woken. */
  attached?: { has(agentId: string): boolean };
  now?: () => number;
  /** How long a call is waited for before a receipt (default 15 s). */
  fastPathMs?: number;
  /** The longest wait of `wait: true`, a sync tool and `await_result` (default 50 s: the agent runtime gives a tool call 60 s). */
  maxWaitMs?: number;
  /** How long a question to the owner, or `wait: false`, still waits for an answer that comes at once (an error, mostly). */
  settleMs?: number;
  log?: (...args: unknown[]) => void;
}

export interface ToolsEdge {
  /** For the link server to mount at `/mcp`. */
  handler(req: IncomingMessage, res: ServerResponse): void;
  /** A new token for each of the agent's lanes; every token it had before stops working. Call on every start of the agent's process. The tokens live in memory only. */
  issueTokens(agentId: string, lanes: string[]): Record<string, string>;
  /** All the agent's tokens stop working. */
  revoke(agentId: string): void;
  /**
   * Once at start, after `router.recover()`: the calls the last process left running answer `result_unknown`, and answers
   * that came in a turn the restart cut off were never told; tell their agents once (a wake, reason `result`).
   */
  recover(): void;
  /** Call when the agent is up (registered) after any start of its process: what is owed to it, because its turn ended without `turn.ended` (a crash, a restart) or a wake could not be sent, is told now. */
  catchUp(agentId: string): void;
  /** The tools an attached caller may use, with their descriptions, for its `tools/list`. */
  attachedTools(agent: string): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  /** One tool call of an attached caller, in the `turn` its app's session names. Not tied to any agent turn. */
  callAttached(agent: string, turn: string, name: string, args: unknown, signal: AbortSignal): Promise<Shaped>;
  /** Stop every running call and forget all tokens. */
  close(): void;
}

/** What an attached caller is given: the way to every word, the receipts, and Ash's agents. Nothing is added by its identity. */
export const ATTACHED_TOOLS: readonly string[] = Object.freeze(["capability_list", "capability_describe", "capability_call", "await_result", "list_pending", "cancel", "agent_list", "agent_ask", "agent_tell"]);
const ATTACHED_CALL_NOTE = " You are an app outside Ash, not one of its agents: when the owner has been asked (status waiting_owner, with a pending_id) their answer does not come to you as a message. Do not poll in a loop: tell the user to answer on the phone, then read it with capability_call {member: \"service:gate\", word: \"pending.get\", body: {id: pending_id}}; if the answer is yes, run it with word pending.redeem, otherwise leave it.";

export const FAST_PATH_MS = 15_000;
export const MAX_WAIT_MS = 50_000;
const SETTLE_MS = 300;
const DEFAULT_APPROVAL_MINUTES = 10;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const KEEP_SETTLED = 100;
/** Who the tool surface is when it wakes an agent for a result (SPEC-02 §3.4). */
const TOOLS_CALLER: Caller = { member: "service:tools", via: "service", local: true };

interface Job {
  id: string;
  agent: string;
  member: string;
  word: string;
  label: string;
  at: number;
  mode: WaitMode;
  expires_at?: number;
  controller: AbortController;
  /** Set when the call has its answer. Images are still in it. */
  shaped: Shaped | null;
  done: Promise<Shaped>;
  /** In the table (a receipt was given, or the gate parked the call). */
  persisted: boolean;
  /** How many await_result calls are waiting for this one now: they will hand the answer over, so no wake yet. */
  awaiting: number;
  /** The router holds the call for the owner's answer until about this time (Unix ms): the call is waited for until then. */
  holdUntil?: number;
}

interface Dispatch {
  agent: string;
  turn: string;
  to: string;
  word: string;
  body: Record<string, unknown>;
  label: string;
  mode: WaitMode;
  wait?: boolean;
  waitByDefault?: boolean;
  approval?: { ttl_minutes?: number; purpose?: string };
}

const text = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The promise's value, or undefined after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

export function createToolsEdge(options: ToolsEdgeOptions): ToolsEdge {
  const { router, registry, ledger } = options;
  const now = options.now ?? Date.now;
  const fastPathMs = options.fastPathMs ?? FAST_PATH_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const table = new JobTable(ledger.db(), now);
  let closed = false;

  // ---- identity: a token per (agent, lane), in memory only. The key is the hash, so nothing compares the token itself.
  // The lane is the session the agent holds open for that kind of work (front, back...); its token is the only thing that
  // says which turn a call belongs to, so a call can never be recorded in, or speak in, another lane's turn.
  interface Identity { agent: string; lane: string }
  const identityOfToken = new Map<string, Identity>();
  const tokensOfAgent = new Map<string, string[]>();
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");

  function revoke(agent: string): void {
    for (const old of tokensOfAgent.get(agent) ?? []) identityOfToken.delete(old);
    tokensOfAgent.delete(agent);
  }
  function issueTokens(agent: string, lanes: string[]): Record<string, string> {
    revoke(agent);
    const out: Record<string, string> = {};
    const hashes: string[] = [];
    for (const lane of lanes) {
      const token = randomBytes(24).toString("base64url");
      identityOfToken.set(hash(token), { agent, lane });
      hashes.push(hash(token));
      out[lane] = token;
    }
    tokensOfAgent.set(agent, hashes);
    return out;
  }
  const authenticate = (req: IncomingMessage): Identity | null => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    return match ? identityOfToken.get(hash(match[1]!)) ?? null : null;
  };

  // ---- calls in flight, and the receipts of the process's life
  const live = new Map<string, Job>();
  const trim = () => {
    if (live.size <= KEEP_SETTLED * 2) return;
    for (const [id, job] of live) { if (job.shaped) live.delete(id); if (live.size <= KEEP_SETTLED) break; }
  };

  /** The attachments the ledger made of the recorded response: every `{$blob, mime, size}` reference in the message `ref` names. */
  function attachmentsOf(ref: string | undefined): Attachment[] {
    const found: Attachment[] = [];
    const walk = (value: unknown, path: string) => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (typeof item.$blob === "string") { found.push({ hash: item.$blob, mime: String(item.mime), size: Number(item.size), ...(path ? { path } : {}) }); return; }
      for (const [key, child] of Object.entries(item)) walk(child, `${path}/${key}`);
    };
    if (ref) walk(ledger.get(ref)?.body, "");
    return found;
  }

  function receiptData(job: Job): Record<string, unknown> {
    return job.mode === "ask"
      ? { status: "waiting_owner", request_id: job.id, member: job.member, word: job.word, ...(job.expires_at ? { expires_at: job.expires_at } : {}),
          guidance: "The owner's answer is not here yet. Do other work or end the turn; collect the answer with await_result and this request_id when you need it, and do not ask the same thing again." }
      : { status: "accepted", request_id: job.id, member: job.member, word: job.word,
          guidance: "It is still running. Call await_result with this request_id; do not call it again. Cancel it with cancel." };
  }

  function persist(job: Job, turn: string | null): void {
    if (job.persisted) return;
    table.insert({ id: job.id, agent: job.agent, turn, member: job.member, word: job.word, label: job.label, at: job.at });
    job.persisted = true;
  }

  // ---- the result comes back by itself (SPEC-02 §3.4): a receipt's answer is told to its agent in a wake, once, when the
  // turn that made the call is over and the agent has not fetched the answer.
  const turnActive = (agent: string, turn: string | null): boolean => turn !== null && (options.attached?.has(agent) === true || options.turnActive(agent, turn));

  function wakeAgent(row: JobRow): void {
    const outcome = row.outcome ?? failure("result_unknown", "Ash restarted while this call was running; whether it was done is not known.");
    if (!options.agentPolicy(row.agent)) { options.log?.("tool surface: no agent to wake for the result", row.agent, row.id); return; }
    // A wake that could not be sent (the agent is stopped, restarting...) is owed again: the next start of the agent, or of the hub, tries it.
    const unsent = (why: unknown) => { options.log?.("tool surface: could not wake", row.agent, "for", row.id, why); if (!closed) table.unclaim(row.id); };
    const body = { lane: "back", reason: "result", context: { request_id: row.id, member: row.member, word: row.word, label: row.label, outcome: wakeOutcome(outcome, row.id) } };
    router.send({ to: row.agent, kind: "request", word: "wake", body }, TOOLS_CALLER)
      .then((reply) => { if (!reply.ok) unsent(reply.error.code); }, unsent);
  }

  /** Wake the agent for this call if it is owed: settled, not fetched, not told yet, and its turn is over. */
  function wakeIfDue(id: string): void {
    if (closed) return;
    const row = table.get(id);
    if (!row || row.state === "running" || row.taken || row.woken || turnActive(row.agent, row.turn) || live.get(id)?.awaiting) return;
    if (table.claimWake(id)) wakeAgent(table.get(id)!);
  }

  /** The sweeps at start wake the agents that are members of the registry (running, or still starting: the words wait in their inbox); an agent that is not one (off, given up on) is left to its own start (`catchUp`): no attempt, no log line. */
  function sweep(ids: string[]): void {
    for (const id of ids) { const row = table.get(id); if (row && registry.describe(row.agent)) wakeIfDue(id); }
  }

  const stopListening = router.subscribe?.({ word: "turn.ended" }, (m) => {
    const turn = (m.body as { turn?: unknown } | null)?.turn;
    if (typeof turn === "string") for (const id of table.owing(m.from, turn)) wakeIfDue(id);
  });

  function shapeReply(job: Job, reply: Reply & { ref?: string }): Shaped {
    if (!reply.ok) return shapeError(reply.error);
    const data = reply.result?.data;
    if (isObject(data) && data.status === "waiting_owner") {
      // The gate parked the call for the owner: the same receipt, with the id of this call next to the pending_id.
      return plain({ ...data, request_id: job.id, member: job.member, word: job.word,
        guidance: "The owner has been asked; do not poll. Their answer arrives as their own message in the conversation (`[answers <pending_id>, option once|always|deny] …`). Then reassess whether the action is still wanted and redeem it with human_pending_redeem {id: pending_id}." });
    }
    return shapeSuccess(reply.result, () => attachmentsOf(reply.ref));
  }

  function start(d: Dispatch): Job {
    const id = `r_${randomBytes(9).toString("base64url")}`;
    const controller = new AbortController();
    const job: Job = { id, agent: d.agent, member: d.to, word: d.word, label: d.label, at: now(), mode: d.mode, controller, shaped: null, done: undefined as unknown as Promise<Shaped>, persisted: false, awaiting: 0,
      ...(typeof d.body.expires_at === "number" ? { expires_at: d.body.expires_at } : {}) };
    const caller: Caller = { member: d.agent, via: "agent", local: true, turn: d.turn };
    const opts = { signal: controller.signal, ...(d.approval ? { approval: d.approval } : {}), waiting: (until: number) => { job.holdUntil = until; } };
    job.done = Promise.resolve()
      .then(() => router.send({ to: d.to, kind: "request", word: d.word, body: d.body }, caller, opts))
      .then((reply) => shapeReply(job, reply), (error) => { options.log?.("tool call failed", d.to, d.word, error); return failure("internal", "Ash failed while handling this call"); })
      .then((shaped) => {
        job.shaped = shaped;
        // Shutting down aborts the calls: they stay as they were, so the next process finds them interrupted and tells their agents.
        if (closed) return shaped;
        // A call the gate parked is final for this call: keep the receipt so it can be found again. Its answer comes from service:gate, so no wake.
        if (!job.persisted && isWaitingOwner(shaped)) { table.insert({ id, agent: job.agent, turn: d.turn, member: job.member, word: job.word, label: job.label, at: job.at, outcome: shaped, woken: true }); job.persisted = true; }
        else if (job.persisted) { table.settle(id, shaped, !isWaitingOwner(shaped)); wakeIfDue(id); }
        return shaped;
      });
    live.set(id, job);
    trim();
    return job;
  }

  /** One call to a word, answered inline or with a receipt. */
  async function dispatch(d: Dispatch, signal: AbortSignal): Promise<Shaped> {
    const job = start(d);
    const abort = () => job.controller.abort();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    try {
      const waitMs = d.mode === "sync" ? maxWaitMs
        : d.mode === "ask" || d.wait === false ? settleMs
        : d.wait === true || (d.wait === undefined && d.waitByDefault) ? maxWaitMs : fastPathMs;
      let settled = await within(job.done, waitMs);
      // A call the router holds for the owner's answer is waited for until then (never past the longest wait): their answer then comes inline.
      while (!settled && !job.shaped && job.holdUntil !== undefined && d.mode !== "ask" && d.wait !== false) {
        const left = Math.min(job.holdUntil, job.at + maxWaitMs) - now();
        if (left <= 0) break;
        settled = await within(job.done, left);
      }
      if (settled || job.shaped) { if (!job.persisted) live.delete(job.id); return settled ?? job.shaped!; }
      persist(job, d.turn);
      return plain(receiptData(job));
    } finally { signal.removeEventListener("abort", abort); }
  }

  async function awaitResult(agent: string, lane: string, id: string, timeoutMs: number, signal: AbortSignal, fixedTurn?: string): Promise<Shaped> {
    const job = live.get(id);
    if (job && job.agent === agent) {
      if (!job.shaped) {
        const callerTurn = fixedTurn ?? options.currentTurn(agent, lane);
        job.awaiting++;
        try { await within(Promise.race([job.done, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]), timeoutMs); }
        finally { job.awaiting--; }
        // The one who waited may be gone (the owner interrupted the turn and the runtime dropped the call): nobody reads this
        // answer, so it is not taken; it is told like any other answer that was not fetched.
        if (signal.aborted || (callerTurn !== null && !turnActive(agent, callerTurn))) { wakeIfDue(id); return plain(receiptData(job)); }
        if (!job.shaped) return plain(receiptData(job));
      }
      table.take(id);
      return job.shaped;
    }
    const row = table.find(agent, id);
    if (!row) return failure("not_found", `no receipt ${id} of yours`, { recovery_hint: "Use the request_id exactly as a receipt gave it; list_pending shows your calls that are still running." });
    table.take(id);
    return row.outcome ?? failure("result_unknown", "Ash restarted while this call was running; whether it was done is not known.");
  }

  // ---- one tool call
  const num = (value: unknown, name: string, min: number, max: number): string | null =>
    value === undefined || (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) ? null : `${name} must be an integer from ${min} to ${max}`;

  /** The call envelope (SPEC-02 §3.3) is taken out of the arguments first; what is left is the word's body. */
  function envelope(args: Record<string, unknown>, approval: boolean, wait: boolean): { rest: Record<string, unknown>; approval?: Dispatch["approval"]; wait?: boolean } | Shaped {
    const rest = { ...args };
    const out: { rest: Record<string, unknown>; approval?: Dispatch["approval"]; wait?: boolean } = { rest };
    if (approval) {
      const ttl = args.approval_ttl_minutes, purpose = args.purpose;
      const problem = num(ttl, "approval_ttl_minutes", 1, 10080) ?? (purpose !== undefined && (!text(purpose) || purpose.length > 500) ? "purpose must be text of at most 500 characters" : null);
      if (problem) return failure("bad_request", problem);
      for (const name of ENVELOPE_APPROVAL) delete rest[name];
      if (ttl !== undefined || purpose !== undefined) out.approval = { ...(ttl !== undefined ? { ttl_minutes: ttl as number } : {}), ...(purpose !== undefined ? { purpose: purpose as string } : {}) };
    }
    if (wait) {
      if (args[ENVELOPE_WAIT] !== undefined && typeof args[ENVELOPE_WAIT] !== "boolean") return failure("bad_request", "wait must be true or false");
      if (args[ENVELOPE_WAIT] !== undefined) out.wait = args[ENVELOPE_WAIT] as boolean;
      delete rest[ENVELOPE_WAIT];
    }
    return out;
  }
  const refused = (value: object): value is Shaped => !("rest" in value);

  async function callTool(agent: string, lane: string, name: string, rawArgs: unknown, signal: AbortSignal, fixedTurn?: string): Promise<Shaped> {
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (!isObject(args)) return failure("bad_request", "the arguments must be an object");
    if (!TOOL_NAMES.includes(name)) return failure("not_found", `no tool ${name}`, { recovery_hint: "Use one of the tools you were given." });
    const policy = options.agentPolicy(agent);
    if (!policy) return failure("forbidden", `${agent} is not a declared agent`);

    // The receipt tools answer for the agent's own calls whether or not a turn is running.
    if ((RECEIPT_TOOLS as readonly string[]).includes(name)) {
      if (name === "list_pending") {
        const pending = [...live.values()].filter((job) => job.agent === agent && !job.shaped).sort((a, b) => a.at - b.at)
          .map((job) => ({ request_id: job.id, member: job.member, word: job.word, label: job.label, since: job.at }));
        return plain({ pending });
      }
      if (!text(args.request_id) || !args.request_id) return failure("bad_request", "request_id is required");
      if (name === "cancel") {
        const job = live.get(args.request_id);
        if (job && job.agent === agent) {
          const running = !job.shaped;
          if (running) { job.controller.abort(); table.take(job.id); } // the agent knows how this ended: no wake for it
          return plain({ request_id: job.id, cancelled: running });
        }
        const row = table.find(agent, args.request_id);
        return row ? plain({ request_id: row.id, cancelled: false }) : failure("not_found", `no receipt ${args.request_id} of yours`);
      }
      const problem = num(args.timeout_ms, "timeout_ms", 0, maxWaitMs);
      if (problem) return failure("bad_request", problem);
      return awaitResult(agent, lane, args.request_id, (args.timeout_ms as number | undefined) ?? maxWaitMs, signal, fixedTurn);
    }

    if (!toolAllowed(policy, name)) return failure("forbidden", `${name} is not one of your tools`, { recovery_hint: "Your declaration does not include this tool; use another way or ask the owner." });
    const turn = fixedTurn ?? options.currentTurn(agent, lane);
    if (!turn) return failure("forbidden", "no turn is running for you; Ash tools work only while you are handling a message or a wake", { recovery_hint: "Do this inside a turn." });

    try {
      if (name === "capability_list") return text(args.member) || args.member === undefined ? capabilityList(registry, policy, args.member as string | undefined) : failure("bad_request", "member must be text");
      if (name === "capability_describe") {
        if (!text(args.member) || !args.member) return failure("bad_request", "member is required");
        if (args.word !== undefined && !text(args.word)) return failure("bad_request", "word must be text");
        return capabilityDescribe(registry, policy, args.member, args.word as string | undefined);
      }
      if (name === "capability_call") {
        if (!text(args.member) || !text(args.word) || !args.member || !args.word) return failure("bad_request", "member and word are required");
        if (args.body !== undefined && !isObject(args.body)) return failure("bad_request", "body must be an object");
        const { member, word, body, ...top } = args;
        const taken = envelope(top, true, true);
        if (refused(taken)) return taken;
        if (Object.keys(taken.rest).length) return failure("bad_request", `unknown arguments: ${Object.keys(taken.rest).join(", ")}; the word's input goes in body`);
        return await dispatch({ agent, turn, to: member, word, body: (body ?? {}) as Record<string, unknown>, label: word, mode: "receipt", wait: taken.wait, approval: taken.approval }, signal);
      }
      const tool = fixedTool(name)!;
      const taken = envelope(args, tool.approval, tool.wait);
      if (refused(taken)) return taken;
      const body = tool.adapt ? tool.adapt(taken.rest, { now: now(), ttlMinutes: taken.approval?.ttl_minutes ?? DEFAULT_APPROVAL_MINUTES }) : taken.rest;
      return await dispatch({ agent, turn, to: tool.member, word: tool.word, body, label: tool.contract.label.doing, mode: tool.mode, wait: taken.wait,
        waitByDefault: tool.waitByDefault, approval: taken.approval }, signal);
    } catch (error) {
      options.log?.("tool failed", name, error);
      return failure("internal", "Ash failed while handling this call");
    }
  }

  // ---- transport
  function reply(res: ServerResponse, status: number, code: Parameters<typeof errorBody>[0], message: string, headers: Record<string, string> = {}): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify({ error: errorBody(code, message) }));
  }

  // The MCP door is stateless, so a `notifications/cancelled` is a POST of its own and never reaches the handler of the call it
  // names. The running tools/call of a (agent, lane) are kept by their JSON-RPC id, so that POST can stop the right one.
  const calling = new Map<string, AbortController>();

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page on the phone could reach a loopback port; only the agent runtime (no Origin) may talk here.
    if (req.headers.origin !== undefined) return reply(res, 403, "forbidden", "requests with an Origin header are refused");
    const who = authenticate(req);
    if (!who) return reply(res, 401, "unauthorized", "a valid bearer token is required", { "www-authenticate": "Bearer" });
    if (req.method !== "POST") return reply(res, 405, "bad_request", "POST only", { allow: "POST" });
    const { agent, lane } = who;
    if (!options.agentPolicy(agent)) return reply(res, 403, "forbidden", `${agent} is not a declared agent`);

    let raw = "";
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) return reply(res, 413, "too_large", "request too large");
      raw += chunk;
    }
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { return reply(res, 400, "bad_request", "the body is not JSON"); }

    const rpc = isObject(body) ? body : null;
    const callKey = (id: unknown) => `${agent}/${lane}/${typeof id}:${String(id)}`;
    if (rpc?.method === "notifications/cancelled" && isObject(rpc.params)) calling.get(callKey(rpc.params.requestId))?.abort();
    let own: AbortController | undefined;
    if (rpc?.method === "tools/call" && (typeof rpc.id === "number" || typeof rpc.id === "string")) {
      const key = callKey(rpc.id), mine = own = new AbortController();
      calling.set(key, mine);
      res.on("close", () => { if (calling.get(key) === mine) calling.delete(key); });
    }

    // Stateless: one MCP server per request, so nothing of an agent survives in the transport.
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } });
    // No resources, said explicitly: the agent runtime asks, and otherwise prints a warning on its protocol stream.
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const policy = options.agentPolicy(agent);
      return { tools: policy ? toolDefinitions().filter((tool) => toolAllowed(policy, tool.name)).map((tool) => ({ ...tool })) : [] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => await callTool(agent, lane, call.params.name, call.params.arguments, own ? AbortSignal.any([extra.signal, own.signal]) : extra.signal) as never);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return {
    handler(req, res) {
      serve(req, res).catch((error) => {
        options.log?.("tool surface request failed", error);
        reply(res, 500, "internal", "the tool surface failed");
      });
    },
    issueTokens,
    revoke,
    attachedTools(agent) {
      const policy = options.agentPolicy(agent);
      if (!policy || !options.attached?.has(agent)) return [];
      return toolDefinitions().filter((tool) => ATTACHED_TOOLS.includes(tool.name) && toolAllowed(policy, tool.name))
        .map((tool) => ({ ...tool, ...(tool.name === "capability_call" ? { description: tool.description + ATTACHED_CALL_NOTE } : {}) }));
    },
    async callAttached(agent, turn, name, args, signal) {
      if (!options.attached?.has(agent)) return failure("forbidden", `${agent} is not an attached caller`);
      if (!ATTACHED_TOOLS.includes(name)) return failure("not_found", `no tool ${name}`, { recovery_hint: `Use one of: ${ATTACHED_TOOLS.join(", ")}.` });
      return callTool(agent, "attached", name, args, signal, turn);
    },
    recover() {
      // Whatever is owed, from any turn: a turn the last process was in is not running now.
      sweep(table.owed());
    },
    catchUp(agentId) {
      sweep(table.owed(agentId));
    },
    close() {
      closed = true;
      stopListening?.();
      for (const job of live.values()) if (!job.shaped) job.controller.abort();
      identityOfToken.clear();
      tokensOfAgent.clear();
    },
  };
}

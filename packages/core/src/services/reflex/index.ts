/**
 * `service:reflex`: the hub's small-model judgements (HUB-MODULES §3).
 *
 *   conversation.control {message_id, agent, lane?}   the owner spoke while an agent was busy: interrupt, pause,
 *                                                     steer, or followup. Keywords first, JEV when unclear. A judgement
 *                                                     that fails is followup: nothing is touched.
 *   task.outcome {turn}                               a label for how a finished turn ended, for the island and capsule
 *   task.stop {turn}, task.end {turn, pending_ids}    the owner stops or ends a task: sent on as session words
 *                                                     of service:agents, and only for the turn that is still running
 *
 * conversation.control only judges. Acting on the answer (interrupt, steer, queue, pause) is the inbox's job, which
 * has the batch in hand. Nothing here imports an edge: JEV arrives as an injected function and every action is a
 * word sent through the router.
 */
import { WordError, type Caller, type HandleContext, type Message, type Reply, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger, LedgerMessage } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";
import { choiceAnswer, conversationQuestions, readConversation, taskOutcomeQuestions, TASK_OUTCOMES, type ConversationState, type Jev } from "./jev";
import { judgeStopKeyword } from "./keywords";

export { createJev, type Jev, type JevOptions, type JevPost, TASK_OUTCOMES, type TaskOutcome } from "./jev";
export { judgeStopKeyword } from "./keywords";

export const REFLEX_ID = "service:reflex";
const AGENTS = "service:agents";
const GATE = "service:gate";
const OWNER = "person:owner";
/** Below this a JEV answer is not acted on (conversation.control) and no label is given (task.outcome). */
const DEFAULT_THRESHOLD = 0.6;

export type ControlAction = "interrupt" | "pause" | "steer" | "followup";

export interface ReflexOptions {
  ledger: Pick<Ledger, "get" | "page" | "db">;
  router: Pick<Router, "send">;
  /** The JEV judge. Without it only the keywords judge and everything unclear is followup. */
  jev?: Pick<Jev, "evaluate">;
  threshold?: number;
  /** One line for something that went wrong and was passed over (default: console.warn). */
  log?: (line: string) => void;
}

const SELF: Caller = { member: REFLEX_ID, via: "service", local: true };
const clip = (value: unknown, n: number): string => (typeof value === "string" ? value : "").slice(0, n);
type Row = Record<string, unknown>;
const parse = (text: unknown): Record<string, unknown> => {
  try { const value = JSON.parse(String(text)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
};

/** Waits for the work, but gives up the moment the signal fires. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(new Error("aborted")); }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("aborted"));
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A failure in one short line for the log: its own message (the llm edge never puts a key or message text in one). */
const whyFailed = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error ?? "error").replace(/[\r\n]+/g, " ").slice(0, 160);

interface TurnInfo { turn: string; agent: string; lane: string; ids: string[]; seq: number; running: boolean; outcome?: string }

export function createReflexService(options: ReflexOptions): Member {
  const { ledger, router } = options;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const db = () => ledger.db();
  const log = options.log ?? ((line: string) => console.warn(`[service:reflex] ${line}`));

  const rowInfo = (row: Row): Omit<TurnInfo, "running" | "outcome"> => {
    const body = parse(row.body);
    return { turn: String(body.turn), agent: String(row.from), lane: String(body.lane ?? ""), seq: Number(row.seq),
      ids: Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [] };
  };
  /** A turn from the ledger's `turn.started` and `turn.ended` events. It runs while nothing has ended it and no newer turn started on its lane. */
  function turnInfo(turn: string): TurnInfo | null {
    const row = db().prepare(`SELECT seq,"from",body FROM messages WHERE kind='event' AND word='turn.started' AND json_extract(body,'$.turn')=? ORDER BY seq LIMIT 1`).get(turn) as Row | undefined;
    if (!row) return null;
    const info = rowInfo(row);
    const ended = db().prepare(`SELECT body FROM messages WHERE kind='event' AND word='turn.ended' AND "from"=? AND json_extract(body,'$.turn')=? ORDER BY seq LIMIT 1`).get(info.agent, turn) as Row | undefined;
    const newer = db().prepare(`SELECT 1 FROM messages WHERE kind='event' AND word='turn.started' AND "from"=? AND seq>? AND json_extract(body,'$.lane')=? LIMIT 1`).get(info.agent, info.seq, info.lane);
    return { ...info, running: !ended && !newer, ...(ended ? { outcome: String(parse(ended.body).outcome ?? "") } : {}) };
  }
  /** The newest turn of the agent that has not ended (on the lane, when one is named). */
  function runningTurn(agent: string, lane?: string): Omit<TurnInfo, "running"> | null {
    const rows = db().prepare(`SELECT s.seq,s."from",s.body FROM messages s WHERE s."from"=? AND s.kind='event' AND s.word='turn.started'
      AND NOT EXISTS (SELECT 1 FROM messages e WHERE e."from"=s."from" AND e.kind='event' AND e.word='turn.ended' AND e.seq>s.seq
        AND json_extract(e.body,'$.turn')=json_extract(s.body,'$.turn')) ORDER BY s.seq DESC LIMIT 20`).all(agent) as Row[];
    const found = rows.map(rowInfo).find((info) => lane === undefined || info.lane === lane);
    return found ?? null;
  }
  const textOf = (id: string): LedgerMessage | null => ledger.get(id);

  function conversationState(message: LedgerMessage, turn: ReturnType<typeof runningTurn>): ConversationState {
    const first = turn?.ids.map(textOf).find((item) => item?.word === "say");
    const recent = ledger.page({ before: message.seq, limit: 50 })
      .filter((item) => item.word === "say" && (item.from === OWNER || item.from === turn?.agent) && typeof (item.body as { text?: unknown })?.text === "string")
      .slice(-2).map((item) => clip((item.body as { text?: string }).text, 500));
    return { current_task: clip((first?.body as { text?: unknown } | undefined)?.text, 500), latest_user_message: clip((message.body as { text?: unknown }).text, 500), recent_messages: recent };
  }

  async function control(body: Record<string, unknown>, ctx: HandleContext): Promise<WordResult> {
    const messageId = body.message_id, agent = body.agent;
    if (typeof messageId !== "string" || !messageId || typeof agent !== "string" || !agent) throw new WordError("bad_request", "message_id and agent are required");
    const lane = typeof body.lane === "string" && body.lane ? body.lane : undefined;
    const message = ledger.get(messageId);
    if (!message) throw new WordError("not_found", "no such message");
    const text = (message.body as { text?: unknown } | null)?.text;
    const keyword = judgeStopKeyword(text);
    const done = (action: ControlAction, confidence: number, stage: "keyword" | "jev"): WordResult => ({ data: { action, confidence, stage } });
    if (keyword.intent === "stop") return done("interrupt", keyword.confidence, "keyword");
    if (keyword.intent === "pause") return done("pause", keyword.confidence, "keyword");
    // Unclear or unrelated: JEV decides when it is there. Whatever goes wrong, the message just waits for the next turn.
    if (!options.jev) return done("followup", 0, "keyword");
    try {
      const state = conversationState(message, runningTurn(agent, lane));
      const judged = readConversation(await until(options.jev.evaluate(state, conversationQuestions), ctx.signal));
      if (judged.intent === "stop" && judged.confidence >= threshold) return done("interrupt", judged.confidence, "jev");
      if (judged.intent === "redirect" && judged.confidence >= threshold) return done("steer", judged.confidence, "jev");
      return done("followup", judged.confidence, "jev");
    } catch (error) {
      // The judge could not answer (a refused key, a timeout, a malformed answer): say so, with no message text, then fall back.
      if (!ctx.signal.aborted) log(`conversation.control ${agent}: JEV failed, fell back to keywords (${whyFailed(error)})`);
      return done("followup", 0, "keyword");
    }
  }

  async function outcome(body: Record<string, unknown>, ctx: HandleContext): Promise<WordResult> {
    const turn = body.turn;
    if (typeof turn !== "string" || !turn) throw new WordError("bad_request", "turn is required");
    const info = turnInfo(turn);
    if (!info) throw new WordError("not_found", "no such turn");
    if (info.outcome === undefined) throw new WordError("conflict", "the turn has not ended");
    if (info.outcome !== "completed") throw new WordError("conflict", `the turn ended ${info.outcome}; only a completed turn gets a label`);
    if (!options.jev) throw new WordError("unavailable", "the judge is not configured");
    const replies = (db().prepare(`SELECT body FROM messages WHERE turn=? AND "from"=? AND "to"=? AND kind='request' AND word='say' ORDER BY seq`).all(turn, info.agent, OWNER) as Row[]).map((r) => parse(r.body));
    if (!replies.length) throw new WordError("conflict", "the turn said nothing to the owner");
    const actions = (db().prepare(`SELECT id,word FROM messages WHERE turn=? AND "from"=? AND kind='request' AND "to" IS NOT NULL AND "to"<>? ORDER BY seq`).all(turn, info.agent, OWNER) as Row[]).slice(-12)
      .map((row) => {
        const response = db().prepare(`SELECT body FROM messages WHERE reply_to=? AND kind='response' ORDER BY seq LIMIT 1`).get(String(row.id)) as Row | undefined;
        return { word: String(row.word), ok: parse(response?.body).ok === true };
      });
    const state = {
      owner_request: info.ids.map(textOf).filter((m): m is LedgerMessage => !!m && m.word === "say").map((m) => clip((m.body as { text?: unknown }).text, 4000)),
      final_replies: replies.slice(-4).map((r) => clip(r.text, 4000)),
      actions,
    };
    try {
      const answer = choiceAnswer(await until(options.jev.evaluate(state, taskOutcomeQuestions), ctx.signal), "outcome", TASK_OUTCOMES);
      // Not sure enough counts as the judge not being able to say: the capsule keeps its neutral label.
      if (answer.confidence < threshold) throw new WordError("unavailable", "the judge was not sure enough to give a label");
      return { data: { outcome: answer.choice, confidence: answer.confidence } };
    } catch (error) {
      if (error instanceof WordError) throw error;
      if (!ctx.signal.aborted) log(`task.outcome ${turn}: JEV failed, no label given (${whyFailed(error)})`);
      throw new WordError("unavailable", "the judge could not answer");
    }
  }

  async function send(to: string, word: string, body: unknown): Promise<Reply> {
    return router.send({ to, kind: "request", word, body }, SELF);
  }
  const fail = (reply: { ok: false; error: { code: ConstructorParameters<typeof WordError>[0]; message: string; detail?: unknown; recovery_hint?: string } }): WordError =>
    new WordError(reply.error.code, reply.error.message, { detail: reply.error.detail, recovery_hint: reply.error.recovery_hint });

  /** Interrupts the lane the turn runs on. False when the turn is not the one running there. */
  async function interrupt(info: TurnInfo): Promise<boolean> {
    if (!info.running) return false;
    const reply = await send(AGENTS, "session.interrupt", { agent: info.agent, key: info.lane });
    if (!reply.ok) throw fail(reply);
    return (reply.result?.data as { interrupted?: unknown } | undefined)?.interrupted === true;
  }

  async function stop(body: Record<string, unknown>): Promise<WordResult> {
    if (typeof body.turn !== "string" || !body.turn) throw new WordError("bad_request", "turn is required");
    const info = turnInfo(body.turn);
    return { data: { cancelled: info ? await interrupt(info) : false } };
  }

  async function end(body: Record<string, unknown>): Promise<WordResult> {
    if (typeof body.turn !== "string" || !body.turn) throw new WordError("bad_request", "turn is required");
    const ids = Array.isArray(body.pending_ids) ? body.pending_ids : [];
    if (!ids.every((id) => typeof id === "string" && id)) throw new WordError("bad_request", "pending_ids must be ids");
    const info = turnInfo(body.turn);
    if (!info) return { data: { ended: false } };
    // The owner picked these cards, so the owner's say is enough. One that cannot come down is logged and the rest go on.
    for (const id of ids as string[]) {
      const reply = await send(GATE, "pending.withdraw", { id });
      if (!reply.ok) log(`task.end: pending ${id} was not withdrawn (${reply.error.code}: ${reply.error.message})`);
    }
    return { data: { ended: info.running ? await interrupt(info) : true } };
  }

  return {
    id: REFLEX_ID,
    kind: "service",
    name: "reflex",
    words: (): WordContract[] => wordsOf(REFLEX_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      const body = msg.body && typeof msg.body === "object" && !Array.isArray(msg.body) ? msg.body as Record<string, unknown> : {};
      switch (msg.word) {
        case "conversation.control": return control(body, ctx);
        case "task.outcome": return outcome(body, ctx);
        case "task.stop": return stop(body);
        case "task.end": return end(body);
        default: throw new WordError("not_found", `service:reflex has no word ${msg.word}`);
      }
    },
  };
}

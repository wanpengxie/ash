/**
 * `service:history`: look back through the ledger (HUB-MODULES §3, SPEC-08 §2.6). Everything is read from the ledger;
 * no full-text or vector index (`query` uses the ledger's LIKE).
 *
 *   query {text?, speaker?, lane?, thread?, before?, after?, limit?}   newest first
 *   read {from_seq, to_seq}     messages by sequence range, oldest first, at most 200
 *   turn {turn}                 one turn of an agent: what it was given, what it said, its tool calls
 *   activity {id, offset}       the detail of one tool call (request and answer), paged by characters
 *   exchanges {agent?, before?, limit?}   the team's own conversation (asks, tells, spawned tasks and their answers), newest first
 *
 * The ledger holds only masked versions (SPEC-01 §10.0), so a row is safe for every caller as stored; nothing is
 * masked again here.
 */
import { activityDetail } from "../../../../sdk/src/activity";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger, LedgerMessage } from "../../kernel/ledger";
import { createWindowReader } from "./window";

export const HISTORY_ID = "service:history";
export const DEFAULT_QUERY_LIMIT = 30;
export const MAX_READ_MESSAGES = 200;
/** How many characters of an activity detail one call returns. */
export const ACTIVITY_PAGE_CHARS = 16_000;
/** `lane` is found through the `turn.started` events; at most this many are looked at. */
const LANE_TURNS = 500;

export interface HistoryOptions {
  ledger: Pick<Ledger, "page" | "get" | "db">;
  now?: () => number;
}

const MAX_SEQ = Number.MAX_SAFE_INTEGER;
export const DEFAULT_EXCHANGES = 30;
/** The words of an exchange are cut to this many characters; the page folds what is long. */
const EXCHANGE_CHARS = 4000;
/** A string in a ledger body, or the summary of one that was kept apart as a blob. */
const textOf = (value: unknown): string => typeof value === "string" ? value
  : value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string" ? (value as { summary: string }).summary : "";
const cut = (text: string) => text.length > EXCHANGE_CHARS ? `${text.slice(0, EXCHANGE_CHARS)}…` : text;
const BATCH = 1000;
const MAX_BATCHES = 20;

export function createHistoryService(options: HistoryOptions): Member {
  const { ledger } = options;
  const db = ledger.db();
  const windows = createWindowReader(ledger, options.now);

  /** The turns and the messages delivered in them, for the turns that ran on a lane. */
  function laneScope(lane: string): { turns: Set<string>; ids: Set<string> } {
    const rows = db.prepare("SELECT body FROM messages WHERE word='turn.started' AND json_extract(body,'$.lane')=? ORDER BY seq DESC LIMIT ?").all(lane, LANE_TURNS) as { body: string }[];
    const turns = new Set<string>(), ids = new Set<string>();
    for (const row of rows) {
      const b = JSON.parse(row.body) as { turn?: string; ids?: string[] };
      if (b.turn) turns.add(b.turn);
      for (const id of b.ids ?? []) ids.add(id);
    }
    return { turns, ids };
  }

  function query(body: Record<string, unknown>) {
    const limit = (body.limit as number | undefined) ?? DEFAULT_QUERY_LIMIT;
    const base = {
      ...(body.text !== undefined ? { text: body.text as string } : {}), ...(body.speaker !== undefined ? { from: body.speaker as string } : {}),
      ...(body.thread !== undefined ? { thread: body.thread as string } : {}), ...(body.after !== undefined ? { after: body.after as number } : {}),
    };
    let before = (body.before as number | undefined) ?? MAX_SEQ;
    const scope = body.lane === undefined ? null : laneScope(body.lane as string);
    const found: LedgerMessage[] = [];
    // Newest first, in windows. Without a lane filter one window is enough.
    for (let i = 0; i < MAX_BATCHES && found.length < limit; i++) {
      const window = ledger.page({ ...base, before, limit: scope ? BATCH : limit });
      if (!window.length) break;
      for (const m of [...window].reverse()) {
        if (scope && !(scope.ids.has(m.id) || (m.turn !== undefined && scope.turns.has(m.turn)))) continue;
        found.push(m);
        if (found.length >= limit) break;
      }
      if (window.length < (scope ? BATCH : limit)) break;
      before = window[0]!.seq;
    }
    const last = found[found.length - 1];
    return { messages: found, ...(found.length >= limit && last ? { next_before: last.seq } : {}) };
  }

  function read(body: Record<string, unknown>) {
    const from = body.from_seq as number, to = body.to_seq as number;
    if (to < from) throw new WordError("bad_request", "to_seq must not be smaller than from_seq");
    if (to - from + 1 > MAX_READ_MESSAGES) throw new WordError("too_large", `a range holds at most ${MAX_READ_MESSAGES} messages; read it in pieces`);
    const messages = ledger.page({ after: from - 1, limit: MAX_READ_MESSAGES }).filter((m) => m.seq <= to);
    return { messages: messages };
  }

  /**
   * Asks, tells and spawned tasks between members of the team: to service:agents (the target is `body.agent`; a spawned
   * worker's id is in the answer) or straight to an agent, from an agent or the owner. The owner's `say` is not one: that is
   * the main conversation.
   */
  function exchanges(body: Record<string, unknown>) {
    const limit = (body.limit as number | undefined) ?? DEFAULT_EXCHANGES;
    const agent = body.agent as string | undefined;
    const rows = db.prepare(`SELECT id FROM messages WHERE kind='request' AND seq<? AND word IN ('ask','tell','spawn')
      AND NOT (word='tell' AND reply_to IS NOT NULL)
      AND (("to"='service:agents') OR ("to" LIKE 'agent:%' AND word<>'spawn')) AND ("from" LIKE 'agent:%' OR "from"='person:owner')
      ${agent ? `AND ("from"=? OR "to"=? OR json_extract(body,'$.agent')=? OR EXISTS
        (SELECT 1 FROM messages r WHERE r.reply_to=messages.id AND r.kind='response' AND json_extract(r.body,'$.result.data.agent')=?))` : ""}
      ORDER BY seq DESC LIMIT ?`).all(...[(body.before as number | undefined) ?? MAX_SEQ, ...(agent ? [agent, agent, agent, agent] : []), limit]) as { id: string }[];
    const items = rows.map(({ id }) => {
      const m = ledger.get(id)!;
      const b = (m.body ?? {}) as Record<string, unknown>;
      const answerRow = db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='response' ORDER BY seq LIMIT 1").get(id) as { id: string } | undefined;
      const r = answerRow ? ledger.get(answerRow.id) : null;
      const reply = (r?.body ?? {}) as { ok?: boolean; result?: { data?: Record<string, unknown> }; error?: { code?: string; message?: string } };
      const data = reply.result?.data ?? {};
      const to = m.to === "service:agents" ? textOf(b.agent) || textOf(data.agent) || "agent:worker" : m.to!;
      const toldRow = m.word === "tell" ? db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='request' AND word='tell' AND \"from\"=? ORDER BY seq LIMIT 1").get(id, to) as { id: string } | undefined : undefined;
      const told = toldRow ? ledger.get(toldRow.id) : null;
      const answerMessage = told ?? r;
      const answer = told ? { text: cut(textOf((told.body as Record<string, unknown>)?.text)) } : r ? (reply.ok === false ? { error: reply.error?.code === "result_unknown" || reply.error?.code === "timeout" ? "结果未知：中断前可能已经处理，请先确认原委托。" : textOf(reply.error?.message) || textOf(reply.error?.code) || "failed" } : { text: cut(textOf(data.answer)) }) : null;
      const state = told ? "answered" : !r ? "waiting" : reply.ok === false ? "failed" : m.word === "tell" ? "sent" : "answered";
      return {
        id: m.id, seq: m.seq, ts: m.ts, from: m.from, to, word: m.word, text: cut(textOf(m.word === "spawn" ? b.task : b.text)),
        ...(m.thread ? { thread: m.thread } : {}), ...(m.turn ? { turn: m.turn } : {}), state,
        ...(answerMessage && answer && (told || m.word !== "tell" || "error" in answer) ? { answer: { seq: answerMessage.seq, ts: answerMessage.ts, ...answer } } : {}),
      };
    });
    const last = items[items.length - 1];
    return { items, ...(items.length >= limit && last ? { next_before: last.seq } : {}) };
  }

  function turn(body: Record<string, unknown>) {
    const turnId = body.turn as string;
    const ids = (sql: string, ...args: string[]) => (db.prepare(sql).all(...args) as { id: string }[]).map((r) => r.id);
    const started = ids("SELECT id FROM messages WHERE word='turn.started' AND json_extract(body,'$.turn')=? ORDER BY seq", turnId);
    if (!started.length && !ids("SELECT id FROM messages WHERE turn=? LIMIT 1", turnId).length) throw new WordError("not_found", `no turn ${turnId} in the ledger`);
    const given = started.flatMap((id) => (ledger.get(id)?.body as { ids?: string[] } | undefined)?.ids ?? []).map((id) => ledger.get(id)).filter((m): m is LedgerMessage => m !== null);
    const inTurn = ids("SELECT id FROM messages WHERE turn=? ORDER BY seq", turnId).map((id) => ledger.get(id)!);
    const spoken = inTurn.filter((m) => m.kind === "request" && m.to !== null && /^(person|agent):/.test(m.to));
    const calls = inTurn.filter((m) => m.kind === "request" && m.to !== null && !/^(person|agent):/.test(m.to));
    const native = ids("SELECT id FROM messages WHERE word='agent.tool' AND json_extract(body,'$.turn')=? ORDER BY seq", turnId).map((id) => ledger.get(id)!);
    const tools = [
      ...calls.map((m) => {
        const answer = (db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='response' LIMIT 1").get(m.id) as { id: string } | undefined);
        const response = answer ? ledger.get(answer.id) : null;
        return { seq: m.seq, id: m.id, to: m.to, word: m.word, summary: m.summary,
          ...(response ? { ok: (response.body as { ok?: boolean }).ok === true, result_summary: response.summary } : {}) };
      }),
      ...native.map((m) => { const b = m.body as { name?: string; phase?: string; summary?: string; ok?: boolean }; return { seq: m.seq, native: true, name: b.name, phase: b.phase, summary: b.summary ?? m.summary, ...(b.ok !== undefined ? { ok: b.ok } : {}) }; }),
    ].sort((a, b) => a.seq - b.seq);
    return { turn: turnId, messages: [...given, ...spoken], tools };
  }

  function activity(body: Record<string, unknown>) {
    const request = ledger.get(body.id as string);
    if (!request || request.kind !== "request" || !request.from.startsWith("agent:") || !request.turn || request.to === "person:owner") throw new WordError("not_found", "no such activity");
    const answer = db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='response' LIMIT 1").get(request.id) as { id: string } | undefined;
    const response = answer ? ledger.get(answer.id)! : null;
    const full = activityDetail({ tool: request.word, member: request.to, input: request.body, result: response?.body ?? { status: "pending", note: "尚无返回记录" } });
    const offset = (body.offset as number | undefined) ?? 0;
    const next = Math.min(full.length, offset + ACTIVITY_PAGE_CHARS);
    return { items: [{ text: full.slice(offset, next), total: full.length, tool: request.word, member: request.to }], next_offset: next < full.length ? next : null };
  }

  return {
    id: HISTORY_ID, kind: "service", name: "History",
    words: (): WordContract[] => wordsOf(HISTORY_ID),
    async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as Record<string, unknown>;
      switch (msg.word) {
        case "confirm": return { data: windows.confirm(body) };
        case "window": return { data: windows.window(body) };
        case "current": return { data: windows.current(body) };
        case "activity.page": return { data: windows.activityPage(body) };
        case "activity.count": return { data: { total_count: windows.activityPage({ limit: 1, since_ts: body.since_ts as number | undefined, until_ts: body.until_ts as number | undefined, agent: body.agent as string | undefined }).total_count } };
        case "query": return { data: query(body) };
        case "read": return { data: read(body) };
        case "turn": return { data: turn(body) };
        case "exchanges": return { data: exchanges(body) };
        case "activity": return { data: activity(body) };
        default: throw new WordError("not_found", `service:history has no word ${msg.word}`);
      }
    },
  };
}

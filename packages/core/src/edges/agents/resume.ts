/**
 * Picking up a turn that was cut off: what its tool calls came to, and the words the agent is given to go on. Pure apart
 * from `readCalls`, which reads the ledger. The classes follow the ledger, not what the agent remembers:
 *
 *   done      the call has a reply (success or failure)
 *   unknown   the call went out and no reply came (or the hub answered `result_unknown`): it may have been carried out
 *   waiting   the call is parked for the owner's approval; it is not sent again, the owner's answer carries it on
 */
import type { Db } from "../../kernel/ledger";

export type Effect = "read" | "write" | "act" | "execute";
export interface Call {
  id: string; seq: number; to: string; word: string; args: string; effect: Effect;
  reply?: { ok: boolean; text: string };
  state?: string;
}
export interface Classified { done: Call[]; unknown: Call[]; waiting: Call[] }

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line for a body or a result: JSON, short. */
export function brief(value: unknown, n = 60): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === "{}" ? "" : clip(flat(text), n);
}

export function classify(calls: Call[]): Classified {
  const out: Classified = { done: [], unknown: [], waiting: [] };
  for (const call of calls) {
    if (call.state === "waiting_owner") out.waiting.push(call);
    else if (!call.reply || call.reply.text === "result_unknown") out.unknown.push(call);
    else out.done.push(call);
  }
  return out;
}

const label = (c: Call) => `${c.to === "person:owner" ? "" : `${c.to}/`}${c.word}`;
const withArgs = (c: Call) => `${label(c)}${c.args ? `(${c.args})` : ""}`;

/** Consecutive calls of one word are one entry, "word ×6". */
function collapse(calls: Call[], limit = 8): string {
  const groups: { call: Call; n: number }[] = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && label(last.call) === label(call)) { last.n++; last.call = call; } else groups.push({ call, n: 1 });
  }
  const shown = groups.slice(-limit);
  const text = shown.map((g) => (g.n > 1 ? `${label(g.call)} ×${g.n}` : `${withArgs(g.call)}${g.call.reply && !g.call.reply.ok ? "（失败）" : ""}`)).join("、");
  return groups.length > shown.length ? `…${text}（共 ${calls.length} 次）` : text;
}

const kind = (e: Effect) => (e === "read" ? "只读，可直接重做" : e === "write" ? "写入类，可能已执行，先读回核对" : "动作类，可能已执行，先核对当前状态");

export interface PromptInput {
  at: number; why: string; task: string; calls: Classified;
  /** How to print the time of the cut; default: local HH:MM:SS. */
  clock?: (at: number) => string;
}
const hms = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

export function recoveryPrompt(i: PromptInput): string {
  const lines = [`[ash] 上一轮在 ${(i.clock ?? hms)(i.at)} 被中断（${i.why}）。原任务：「${i.task}」。`];
  const { done, unknown, waiting } = i.calls;
  lines.push(done.length ? `已完成：${collapse(done)}。` : "已完成的调用：无。");
  if (unknown.length) lines.push(`结果不明：${unknown.map((c) => `${withArgs(c)}（${kind(c.effect)}）`).join("；")}。`);
  if (waiting.length) lines.push(`在等主人批准：${waiting.map(withArgs).join("；")}（不用重发，主人答了会照常往下走）。`);
  lines.push("请先核对当前状态（例如先截屏、读回内容、查一下有没有发出去），不要重复已完成的动作，再接着完成原任务。");
  return lines.join("\n");
}

/** The one line the owner sees. */
export const ownerLine = (why: string, task: string) => `刚才中断了（${why}），正在接着做：${clip(flat(task), 60)}`;

const parse = (text: unknown): unknown => { try { return typeof text === "string" ? JSON.parse(text) : text; } catch { return text; } };

/** The calls the agent made in these turns, in order, with the reply of each (the ledger keeps both). `effectOf` answers for a word; unknown -> act. */
export function readCalls(db: Db, agent: string, turns: string[], effectOf: (to: string, word: string) => Effect | undefined): Call[] {
  if (!turns.length) return [];
  const marks = turns.map(() => "?").join(",");
  const reqs = db.prepare(`SELECT m.seq, m.id, m."to" AS to_, m.word, m.body, r.state FROM messages m LEFT JOIN requests r ON r.id=m.id WHERE m.turn IN (${marks}) AND m."from"=? AND m.kind='request' ORDER BY m.seq`)
    .all(...turns, agent) as { seq: number; id: string; to_: string; word: string; body: string; state: string | null }[];
  if (!reqs.length) return [];
  const ids = reqs.map((r) => r.id);
  const replies = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const r of db.prepare(`SELECT reply_to, body FROM messages WHERE kind='response' AND reply_to IN (${part.map(() => "?").join(",")})`).all(...part) as { reply_to: string; body: string }[]) replies.set(r.reply_to, r.body);
  }
  return reqs.map((r) => {
    const call: Call = { id: r.id, seq: r.seq, to: r.to_, word: r.word, args: brief(parse(r.body)), effect: effectOf(r.to_, r.word) ?? "act", ...(r.state ? { state: r.state } : {}) };
    const raw = replies.get(r.id);
    if (raw !== undefined) {
      const body = parse(raw) as { ok?: boolean; error?: { code?: string; message?: string }; result?: { data?: unknown } } | null;
      const ok = body?.ok !== false;
      call.reply = { ok, text: ok ? brief(body?.result?.data, 80) : body?.error?.code === "result_unknown" ? "result_unknown" : brief(body?.error?.message ?? body?.error?.code, 80) };
    }
    return call;
  });
}

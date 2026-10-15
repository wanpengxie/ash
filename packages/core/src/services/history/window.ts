/** Owner-facing, bounded display reads. No ledger body escapes the shared safe projector. */
import { ActivitySteps } from "../../../../sdk/src/activity";
import { projectRecords, safeRecord, type DisplayFact } from "../../../../sdk/src/conversation";
import { WordError } from "../../../../sdk/src/message";
import type { Ledger } from "../../kernel/ledger";

export const WINDOW_BYTES = 256 * 1024;
const DAY = 86_400_000;
type Row = { id: string; seq: number; fact_turn: string; display_type: string; fact_type: string; ts: number };
type Body = { before?: number; after?: number; around_id?: string; snapshot_seq?: number; limit?: number; turn?: string; ids?: string[]; since_ts?: number; until_ts?: number; agent?: string };
type HistoryLedger = Pick<Ledger, "page" | "get" | "db">;

export function createWindowReader(ledger: HistoryLedger, now: () => number = Date.now) {
  const db = ledger.db();
  const dataset = (db.prepare("SELECT value FROM kv WHERE key='dataset_id'").get() as { value: string }).value;
  const rows = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
  const fact = (id: string): DisplayFact | null => {
    const m = ledger.get(id); if (!m) return null;
    const safe = safeRecord(m);
    const state = db.prepare("SELECT state_facts FROM messages WHERE id=?").get(id) as { state_facts: string | null };
    if (!state.state_facts) return safe;
    return { seq: m.seq, id: m.id, ts: m.ts, turn: m.turn ?? "", thread: m.thread ?? "", reply_to: m.reply_to,
      to: m.to, word: m.word, ...safe, ...JSON.parse(state.state_facts) };
  };
  const highest = () => Number((db.prepare("SELECT coalesce(max(seq),0) AS seq FROM messages").get() as Row).seq);
  function snapshot(b: Body) {
    if ([b.before, b.after, b.around_id].filter((x) => x !== undefined).length > 1) throw new WordError("bad_request", "choose before, after or around_id");
    const head = highest(), snap = b.snapshot_seq ?? head;
    if (!Number.isSafeInteger(snap) || snap < 0 || snap > head) throw new WordError("bad_request", "snapshot_seq is outside this ledger");
    return snap;
  }
  function related(target: string, kind: string, snap: number, after: number) {
    return db.prepare("SELECT m.id FROM message_relations r JOIN messages m ON m.seq=r.source_seq WHERE r.target=? AND r.kind=? AND r.source_seq>? AND r.source_seq<=? ORDER BY r.source_seq")
      .iterate(target, kind, after, snap) as Iterable<{ id: string }>;
  }
  function answers(target: string, type: string, snap: number, after: number) {
    return db.prepare("SELECT id FROM messages WHERE reply_to=? AND fact_type=? AND seq>? AND seq<=? ORDER BY seq")
      .iterate(target, type, after, snap) as Iterable<{ id: string }>;
  }
  function hydrate(id: string, snap: number): DisplayFact {
    const base = fact(id)!;
    if (!base) throw new WordError("not_found", "no display item with this id");
    const facts = [base];
    if (base.type === "ask") {
      for (const r of answers(id, "ask.answer", snap, base.seq)) { const a = fact(r.id); if (a) { facts.push(a); break; } }
    } else if (base.type === "owner.say") {
      for (const r of answers(id, "say.result", snap, base.seq)) { const a = fact(r.id); if (a?.accepted) { facts.push(a); break; } }
      // The ids array may itself be externalized. The append-time relation is authoritative for delivery.
      if (db.prepare("SELECT 1 FROM message_relations WHERE target=? AND kind='read' AND source_seq<=? LIMIT 1").get(id, snap))
        facts.push({ type: "turn.start", id: "", seq: snap, ts: 0, turn: "", ids: [id], agent: "agent:main", lane: "front" });
    } else if (base.type === "show" && base.card.type === "options") {
      for (const r of related(id, "option", snap, base.seq)) {
        const a = fact(r.id); if (!a) continue;
        const result = projectRecords([base, a]).conversation.find((item) => item.id === id);
        if (result?.locked) { facts.push(a); break; }
      }
    }
    const item = projectRecords(facts).conversation.find((x) => x.id === id)!;
    if (item.type === "card" && item.card?.type === "a2ui") item.card = card(id, item.card);
    // Aggregate repeated reactions rather than materializing every reaction event in browser or server JS.
    const reactions = db.prepare("SELECT json_extract(m.body,'$.emoji') AS emoji,count(*) AS count,min(m.id) AS id FROM message_relations r JOIN messages m ON m.seq=r.source_seq WHERE r.target=? AND r.kind='react' AND r.source_seq<=? GROUP BY emoji ORDER BY min(r.source_seq) LIMIT 51")
      .all(id, snap) as { emoji: string; count: number; id: string }[];
    item.reactions = reactions.slice(0, 50);
    item.reactions_more = reactions.length > 50;
    return item;
  }
  /** A card in the conversation as it is now (its newest version, what the owner entered, open or not): the human edge keeps it in owner_cards. */
  let cardRow: ReturnType<typeof db.prepare> | null = null;
  const cardStatement = () => cardRow ??= db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_cards'").get()
    ? db.prepare("SELECT id,owner,text,state,form,plan,updated_at FROM owner_cards WHERE message=?") : null;
  function card(message: string, shown: DisplayFact): DisplayFact {
    const r = cardStatement()?.get(message) as { id: string; owner: string; text: string; state: string; form: string | null; plan: string; updated_at: number } | undefined;
    if (!r) return { ...shown, state: "closed" };
    const { problems: _problems, ...plan } = JSON.parse(r.plan) as Record<string, unknown>;
    const form = r.form ? JSON.parse(r.form) as { secret: Record<string, string>; fields: Record<string, { title: string }>; expires_at: number } : null;
    return { type: "a2ui", id: r.id, owner: r.owner, text: r.text, state: r.state, plan, updated_at: r.updated_at,
      ...(form ? { form: { secret: form.secret, titles: Object.fromEntries(Object.entries(form.fields).map(([k, f]) => [k, f.title])), expires_at: form.expires_at } } : {}) };
  }
  function lastOwner(snap: number) {
    return rows("SELECT id,seq,ts FROM messages WHERE display_type='owner.say' AND seq<=? ORDER BY seq DESC LIMIT 1", snap)[0];
  }
  function entitySql(snap: number, time: number) {
    const owner = lastOwner(snap);
    return { sql: `SELECT id,seq FROM messages WHERE display_type IS NOT NULL AND seq<=?
      UNION ALL SELECT e.fact_turn AS id,e.seq FROM messages e WHERE e.fact_type='turn.end' AND e.outcome='error' AND e.seq<=? AND e.ts>? AND e.ts>=?
      AND EXISTS(SELECT 1 FROM messages s WHERE s.fact_type='turn.start' AND s.fact_turn=e.fact_turn AND s.lane='front' AND s.seq<=?)`,
      args: [snap, snap, time - DAY, owner?.ts ?? -1, snap] };
  }
  function failure(id: string, snap: number): DisplayFact {
    const start = rows("SELECT * FROM messages WHERE fact_type='turn.start' AND fact_turn=? AND seq<=? ORDER BY seq LIMIT 1", id, snap)[0]!;
    const end = rows("SELECT * FROM messages WHERE fact_type='turn.end' AND fact_turn=? AND seq<=? ORDER BY seq DESC LIMIT 1", id, snap)[0]!;
    const source = rows("SELECT id FROM messages WHERE display_type='owner.say' AND ts<=? AND seq<=? ORDER BY seq DESC LIMIT 1", start.ts, snap)[0];
    const retry = source ? fact(source.id) : null;
    return { type: "failed", id, seq: end.seq, turn: id, ts: end.ts, expires_at: end.ts + DAY,
      retry: retry && !retry.full && retry.text && !retry.has_attachments && !retry.attachments.length ? { text: retry.text, to: retry.to } : null };
  }
  const itemOf = (r: Row, snap: number) => ledger.get(r.id) ? hydrate(r.id, snap) : failure(r.id, snap);
  const context = (item: DisplayFact | undefined) => item ? Object.fromEntries(["id", "seq", "ts", "side", "from", "kind", "group", "type"].filter((k) => item[k] !== undefined).map((k) => [k, item[k]])) : null;
  function budget(items: DisplayFact[], limit: number) {
    const accepted: DisplayFact[] = []; let bytes = 0;
    for (const item of items.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      const encoded = { ...item, byte_size: size };
      const charged = Buffer.byteLength(JSON.stringify(encoded), "utf8");
      if (accepted.length && bytes + charged > WINDOW_BYTES - 8192) break;
      accepted.push(encoded); bytes += charged;
      if (bytes > WINDOW_BYTES - 8192) break;
    }
    return { items: accepted, oversized: bytes > WINDOW_BYTES - 8192 };
  }
  function window(b: Body) {
    const snap = snapshot(b), time = now(), limit = Math.min(200, Math.max(1, b.limit ?? 40));
    const source = entitySql(snap, time);
    const select = (where: string, args: (number | string)[], descending: boolean, take: number) => rows(`SELECT * FROM (${source.sql}) WHERE ${where} ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT ?`, ...source.args, ...args, take);
    let candidates: Row[];
    if (b.around_id) {
      const target = select("id=?", [b.around_id], false, 1)[0];
      if (!target) throw new WordError("not_found", "no visible item with this id in snapshot");
      const before = select("seq<?", [target.seq], true, Math.floor((limit - 1) / 2)).reverse();
      candidates = [...before, target, ...select("seq>?", [target.seq], false, limit - before.length - 1)];
    } else candidates = select(b.after !== undefined ? "seq>?" : "seq<?", [b.after ?? b.before ?? snap + 1], b.after === undefined, limit);
    const projected = candidates.map((r) => itemOf(r, snap));
    const bounded = budget(projected, limit);
    if (b.around_id && !bounded.items.some((x) => x.id === b.around_id)) Object.assign(bounded, budget([itemOf(candidates.find((x) => x.id === b.around_id)!, snap)], 1));
    const items = b.after === undefined && !b.around_id ? bounded.items.reverse() : bounded.items;
    const first = items[0], last = items.at(-1);
    const prev = first ? select("seq<?", [first.seq], true, 1)[0] : undefined;
    const next = last ? select("seq>?", [last.seq], false, 1)[0] : undefined;
    // Intro is a global-prefix property, never a property of a short viewport slice.
    const prefixRows = rows("SELECT id,seq FROM messages WHERE display_type IS NOT NULL AND seq<=? ORDER BY seq LIMIT 9", snap);
    const prefix: DisplayFact[] = prefixRows.length <= 8 ? prefixRows.map((r) => itemOf(r, snap)) : prefixRows;
    const intro = !prev && prefix.length > 0 && prefix.length <= 8 && prefix[0]?.side === "agent" && !prefix.some((x) => x.side === "owner");
    return { dataset_id: dataset, snapshot_seq: snap, ...bounded, items,
      before: first?.seq ?? null, after: last?.seq ?? null, has_more_before: !!prev, has_more_after: !!next,
      previous: context(prev ? itemOf(prev, snap) : undefined), next: context(next ? itemOf(next, snap) : undefined), intro };
  }
  function turnSummary(start: Row, snap: number): DisplayFact {
    const f = fact(start.id);
    const end = rows("SELECT * FROM messages WHERE fact_type='turn.end' AND fact_turn=? AND seq<=? ORDER BY seq DESC LIMIT 1", start.fact_turn, snap)[0];
    const givenSql = "FROM message_relations r JOIN messages m ON m.id=r.target WHERE r.source_seq=? AND r.kind='read' AND m.display_type='owner.say' AND coalesce(json_extract(m.body,'$.text.summary'),json_extract(m.body,'$.text'),'')!=''";
    const given = rows(`SELECT m.id ${givenSql} ORDER BY r.position LIMIT 1`, start.seq)[0];
    const count = Number((db.prepare(`SELECT count(*) AS n ${givenSql}`).get(start.seq) as { n: number }).n);
    const title = given ? [...fact(given.id)!.text].slice(0, 48).join("") : "";
    const anchor = rows("SELECT m.id FROM message_relations r JOIN messages m ON m.id=r.target WHERE r.source_seq=? AND r.kind='read' AND m.display_type='owner.say' AND m.seq<=? ORDER BY r.position LIMIT 1", start.seq, snap)[0]
      ?? rows("SELECT id FROM messages INDEXED BY m_turn_display WHERE fact_turn=? AND display_type IS NOT NULL AND seq<=? ORDER BY seq LIMIT 1", start.fact_turn, snap)[0];
    const message = ledger.get(start.id)!;
    const background = (start as Row & { lane: string }).lane !== "front";
    const ended = end ? { ts: end.ts, outcome: (end as Row & { outcome: string }).outcome } : null;
    let stepCount = Number((db.prepare("SELECT count(*) AS n FROM messages WHERE fact_turn=? AND seq<=? AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=messages.seq AND r.kind='activity.child') AND ((fact_type='activity.request' AND activity_mode!='poll') OR (fact_type='tool' AND tool_phase='start'))").get(start.fact_turn, snap) as { n: number }).n);
    if (snap === highest()) stepCount += Number((db.prepare("SELECT count(*) AS n FROM messages WHERE fact_turn=? AND seq<=? AND activity_mode='poll' AND activity_state='failed'").get(start.fact_turn, snap) as { n: number }).n);
    else for (const row of db.prepare("SELECT * FROM messages WHERE fact_turn=? AND seq<=? AND activity_mode='poll'").iterate(start.fact_turn, snap) as Iterable<Row>) if (!stepOf(row, snap).hidden) stepCount++;
    return { id: start.fact_turn, seq: start.seq, message_id: anchor?.id ?? null, agent: f?.agent ?? message.from, lane: (start as Row & { lane: string }).lane, background, started: start.ts, step_count: stepCount,
      title: background ? `${message.from.slice(6)} 在后台工作` : title ? `${title}${count > 1 ? ` · ${count} 条` : ""}` : "对话", steps: [],
      ...(ended ? { ended: ended.ts, outcome: ended.outcome } : {}) };
  }
  function stepOf(r: Row, snap: number): DisplayFact {
    const f = fact(r.id)!;
    if (f.type === "tool") {
      const end = related(r.id, "tool.end", snap, r.seq)[Symbol.iterator]().next().value;
      const e = end ? fact(end.id) : null;
      return { id: f.id, seq: f.seq, ts: f.ts, tool: true, label: f.summary || f.name, state: e ? e.ok ? "ok" : "failed" : "pending", ...(e ? { ended: e.ts } : {}) };
    }
    const child = related(r.id, "activity.child", snap, r.seq)[Symbol.iterator]().next().value;
    const second = child ? fact(child.id) : null;
    const activity = new ActivitySteps();
    activity.request(f.id, f.ts, f.action);
    if (second) activity.request(second.id, second.ts, second.action);
    let cursor = r.seq;
    const apply = (response: DisplayFact) => {
      const result = response.result;
      activity.response(response.reply_to, response.ts, result.state === "accepted" ? { status: "accepted", request_id: result.receipt }
        : result.state === "unconfirmed" ? { truncated: true } : result.state === "waiting_owner" ? { status: "waiting_owner" } : { ok: result.state !== "failed" });
      cursor = response.seq;
    };
    const receipts = (until: number) => {
      while (activity.steps[0]?.receipt) {
        const receipt = activity.steps[0].receipt;
        const at = cursor;
        for (const row of answers(receipt, "activity.response", until, cursor)) {
          const response = fact(row.id); if (response) apply(response);
          if (activity.steps[0]?.receipt !== receipt) break;
        }
        if (cursor === at) break;
      }
    };
    const targets = second ? [f.id, second.id] : [f.id];
    const responses = db.prepare(`SELECT id FROM messages WHERE reply_to IN (${targets.map(() => "?").join(",")}) AND fact_type='activity.response' AND seq>? AND seq<=? ORDER BY seq`).iterate(...targets, r.seq, snap) as Iterable<{ id: string }>;
    for (const row of responses) { const response = fact(row.id); if (!response) continue; receipts(response.seq - 1); apply(response); }
    receipts(snap);
    const step = activity.steps[0]!;
    return { ...step, id: f.id, seq: f.seq, tool: true, hidden: step.polling && step.state !== "failed" };
  }
  function activityPage(b: Body) {
    const snap = snapshot(b), limit = Math.min(200, Math.max(1, b.limit ?? 30));
    if (b.turn && [b.since_ts, b.until_ts, b.agent].some((x) => x !== undefined)) throw new WordError("bad_request", "time and agent filters apply to turn summaries only");
    if (b.since_ts !== undefined && b.until_ts !== undefined && b.until_ts < b.since_ts) throw new WordError("bad_request", "until_ts must not precede since_ts");
    const filters = `${b.since_ts !== undefined ? " AND ts>=?" : ""}${b.until_ts !== undefined ? " AND ts<?" : ""}${b.agent !== undefined ? " AND \"from\"=?" : ""}`;
    const filterArgs = [b.since_ts, b.until_ts, b.agent].filter((x): x is number | string => x !== undefined);
    // Date reads must start in the date range, not enumerate every older turn through the generic fact index.
    const source = `messages${b.agent !== undefined ? " INDEXED BY m_agent_activity" : b.since_ts !== undefined || b.until_ts !== undefined ? " INDEXED BY m_activity_started" : ""}`;
    const direction = b.after !== undefined ? "ASC" : "DESC";
    const condition = b.after !== undefined ? "seq>?" : "seq<?";
    let candidates: Row[];
    if (b.turn) candidates = rows(`SELECT * FROM messages WHERE fact_turn=? AND (fact_type='activity.request' OR (fact_type='tool' AND tool_phase='start')) AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=messages.seq AND r.kind='activity.child') AND seq<=? AND ${condition} ORDER BY seq ${direction} LIMIT ?`, b.turn, snap, b.after ?? b.before ?? snap + 1, limit);
    else candidates = rows(`SELECT * FROM ${source} WHERE fact_type='turn.start'${filters} AND seq<=? AND ${condition} ORDER BY seq ${direction} LIMIT ?`, ...filterArgs, snap, b.after ?? b.before ?? snap + 1, limit);
    const items = candidates.map((r) => {
      if (!b.turn) return turnSummary(r, snap);
      return stepOf(r, snap);
    });
    const bounded = budget(items.filter((x) => !x.hidden), limit);
    if (b.after === undefined) bounded.items.reverse();
    const first = bounded.items[0]?.seq ?? (candidates.length ? Math.min(...candidates.map((r) => r.seq)) : null), last = bounded.items.at(-1)?.seq ?? (candidates.length ? Math.max(...candidates.map((r) => r.seq)) : null);
    const scope = b.turn ? "NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=messages.seq AND r.kind='activity.child') AND fact_turn=? AND (fact_type='activity.request' OR (fact_type='tool' AND tool_phase='start'))" : `fact_type='turn.start'${filters}`;
    const args = b.turn ? [b.turn, snap] : [...filterArgs, snap];
    const start = b.turn ? rows("SELECT * FROM messages WHERE fact_type='turn.start' AND fact_turn=? AND seq<=? ORDER BY seq LIMIT 1", b.turn, snap)[0] : undefined;
    const total = b.turn ? start ? turnSummary(start, snap).step_count : 0 : Number((db.prepare(`SELECT count(*) AS n FROM ${source} WHERE ${scope} AND seq<=?`).get(...args) as { n: number }).n);
    const exists = (at: number | null, op: string) => at !== null && !!db.prepare(`SELECT 1 FROM ${source} WHERE ${scope} AND seq<=? AND seq${op}? LIMIT 1`).get(...args, at);
    return { dataset_id: dataset, snapshot_seq: snap, ...bounded, total_count: total, before: first, after: last, has_more_before: exists(first, "<"), has_more_after: exists(last, ">") };
  }
  function current(b: Body) {
    const snap = snapshot(b), time = now(), limit = Math.min(200, Math.max(1, b.limit ?? 40));
    const agentScope = b.agent !== undefined ? ' AND "from"=?' : "";
    const agentArgs = b.agent !== undefined ? [b.agent] : [];
    const pending = `display_type='ask' AND seq<=? AND expires_at>? AND ${snap === highest() ? "answer_seq IS NULL" : "(answer_seq IS NULL OR answer_seq>?)"}${agentScope}`;
    const pendingArgs = [...(snap === highest() ? [snap, time] : [snap, time, snap]), ...agentArgs];
    const total = Number((db.prepare(`SELECT count(*) AS n FROM messages WHERE ${pending}`).get(...pendingArgs) as { n: number }).n);
    const desc = b.after === undefined;
    const selected = rows(`SELECT id,seq FROM messages WHERE ${pending} AND seq${desc ? "<" : ">"}? ORDER BY seq ${desc ? "DESC" : "ASC"} LIMIT ?`, ...pendingArgs, b.after ?? b.before ?? snap + 1, limit);
    const bounded = budget(selected.map((r) => hydrate(r.id, snap)), limit); if (desc) bounded.items.reverse();
    const first = bounded.items[0]?.seq ?? null, last = bounded.items.at(-1)?.seq ?? null;
    const more = (at: number | null, op: string) => at !== null && !!db.prepare(`SELECT 1 FROM messages WHERE ${pending} AND seq${op}? LIMIT 1`).get(...pendingArgs, at);
    const open = rows(`SELECT * FROM messages WHERE fact_type='turn.start' AND lane='front' AND seq<=? AND ${snap === highest() ? "turn_end_seq IS NULL" : "(turn_end_seq IS NULL OR turn_end_seq>?)"}${agentScope} ORDER BY seq DESC LIMIT 1`, ...(snap === highest() ? [snap] : [snap, snap]), ...agentArgs)[0];
    // Keep the time range as the driving table; an idle read must not test every historical start.
    const recent = rows(`SELECT s.* FROM messages e INDEXED BY m_ended CROSS JOIN messages s ON s.fact_turn=e.fact_turn AND s.fact_type='turn.start' WHERE e.fact_type='turn.end' AND e.ts>? AND e.seq<=? AND s.lane='front' AND s.seq<=?${b.agent !== undefined ? ' AND s."from"=?' : ""} ORDER BY s.seq DESC LIMIT 1`, time - 60_000, snap, snap, ...agentArgs)[0];
    const progressStart = open && (!recent || open.seq > recent.seq) ? open : recent;
    const progress = progressStart ? turnSummary(progressStart, snap) : null;
    if (progress) { progress.steps = activityPage({ turn: progress.id, limit: 5, snapshot_seq: snap }).items; progress.steps_more = progress.step_count > progress.steps.length; }
    const pendingTool = open ? rows(`SELECT * FROM messages WHERE fact_turn=? AND fact_type='tool' AND tool_phase='start' AND seq<=? AND ${snap === highest() ? "answer_seq IS NULL" : "(answer_seq IS NULL OR answer_seq>?)"} ORDER BY seq DESC LIMIT 1`, ...(snap === highest() ? [open.fact_turn, snap] : [open.fact_turn, snap, snap]))[0] : undefined;
    let pendingActivity: Row | undefined;
    if (open && snap === highest()) pendingActivity = rows("SELECT * FROM messages WHERE fact_turn=? AND fact_type='activity.request' AND activity_state='pending' AND activity_mode!='poll' AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=messages.seq AND r.kind='activity.child') AND seq<=? ORDER BY seq DESC LIMIT 1", open.fact_turn, snap)[0];
    else if (open) for (const r of db.prepare("SELECT * FROM messages WHERE fact_turn=? AND fact_type='activity.request' AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=messages.seq AND r.kind='activity.child') AND seq<=? ORDER BY seq DESC").iterate(open.fact_turn, snap) as Iterable<Row>) {
      const step = stepOf(r, snap); if (step.state === "pending" && !step.hidden) { pendingActivity = r; break; }
    }
    const pendingStep = [pendingTool, pendingActivity].filter((x): x is Row => !!x).sort((a, b) => b.seq - a.seq)[0];
    const working = pendingStep ? stepOf(pendingStep, snap) : open ? [...(progress?.steps ?? [])].reverse().find((x: DisplayFact) => x.state === "pending") : undefined;
    const presence = open ? { state: working ? "working" : "thinking", text: working?.label ?? "", avatar: working ? "focused" : "thinking" }
      : total ? { state: "waiting_you", text: "", avatar: "listening" } : { state: "idle", text: "", avatar: "default" };
    const askChange = (db.prepare(`SELECT min(expires_at) AS at FROM messages WHERE ${pending}`).get(...pendingArgs) as { at: number | null }).at;
    const failChange = (db.prepare("SELECT min(e.ts+?) AS at FROM messages e WHERE e.fact_type='turn.end' AND e.outcome='error' AND e.seq<=? AND e.ts>? AND e.ts>=? AND EXISTS(SELECT 1 FROM messages s WHERE s.fact_type='turn.start' AND s.fact_turn=e.fact_turn AND s.lane='front' AND s.seq<=?)")
      .get(DAY, snap, time - DAY, lastOwner(snap)?.ts ?? -1, snap) as { at: number | null }).at;
    const nextChange = [askChange, failChange].filter((x): x is number => x !== null);
    if (progress?.ended && progress.ended + 60_000 > time) nextChange.push(progress.ended + 60_000);
    return { dataset_id: dataset, snapshot_seq: snap, revision: snap, as_of: time, next_change_at: nextChange.length ? Math.min(...nextChange) : null,
      ...bounded, total_count: total, presence, progress, before: first, after: last, has_more_before: more(first, "<"), has_more_after: more(last, ">") };
  }
  function confirm(b: Body) {
    const snap = snapshot(b);
    if (!Array.isArray(b.ids) || b.ids.length > 24) throw new WordError("bad_request", "confirm at most 24 outbox ids");
    const ids = b.ids.filter((id) => !!db.prepare("SELECT 1 FROM messages WHERE id=? AND display_type='owner.say' AND seq<=?").get(id, snap));
    return { dataset_id: dataset, snapshot_seq: snap, ids };
  }
  return { window, current, activityPage, confirm };
}

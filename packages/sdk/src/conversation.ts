// Pure ledger projection. _records contains only selected display-safe facts, never tool arguments, raw results or
// credentials. The ledger rows are what `sync` delivers (SPEC-03 §5.2): the message with long fields already replaced by
// `{$blob, mime, size, summary}` references.
import { activityAction, activityResult, activityText, ActivitySteps } from "./activity";

export const OWNER = "person:owner";
const DAY = 86_400_000;

export type DisplayFact = Record<string, any>;
export interface ConversationView { presence: {state: string; text: string; avatar: string}; conversation: DisplayFact[]; turns: Record<string, DisplayFact>; asks: DisplayFact[]; _records: DisplayFact[] }

export function initialView(): ConversationView {
  const view: ConversationView = {
    presence: { state: "idle", text: "", avatar: "default" },
    conversation: [], turns: {}, asks: [], _records: [],
  };
  Object.defineProperty(view, "_records", { value: [], writable: true, enumerable: false });
  return view;
}

const object = (x: any) => x !== null && typeof x === "object" && !Array.isArray(x);
const string = (x: any) => typeof x === "string" ? x : "";
const number = (x: any) => typeof x === "number" && Number.isFinite(x) ? x : null;
const strings = (x: any) => Array.isArray(x) ? x.filter((v: any) => typeof v === "string") : [];
const turnId = (x: any) => typeof x === "string" && x.length > 0 && x.length <= 128;
const memberId = (x: any) => typeof x === "string" && /^(agent|device|service|person|app|body):[A-Za-z0-9_-]+$/.test(x);
const isAgent = (x: any) => typeof x === "string" && /^agent:[a-z][a-z0-9_-]*$/.test(x);
const isBlob = (x: any) => object(x) && typeof x.$blob === "string" && /^[0-9a-f]{64}$/.test(x.$blob);
/** Anyone but the owner may speak to the owner: an agent, an app, the hub itself. */
const publisher = (from: any) => typeof from === "string" && from !== OWNER && memberId(from);

/** A text field of a body: the text itself, or (when it was long) the ledger's short version and where the whole text is. */
function textField(x: any) {
  if (typeof x === "string") return { text: x };
  if (isBlob(x)) return { text: string(x.summary), full: x.$blob };
  return { text: "" };
}

/** How a turn ended, in the words the activity page uses. */
const outcomeOf = (outcome: any) => outcome === "completed" ? "completed" : outcome === "error" ? "error" : outcome === "cancelled" || outcome === "interrupted" ? "cancelled" : "";

function safeCard(card: any) {
  if (!object(card)) return null;
  if (card.type === "options" && Array.isArray(card.options)) return {
    type: "options", prompt: string(card.prompt), allow_custom: card.allow_custom === true,
    options: card.options.filter((x: any) => object(x) && typeof x.id === "string" && typeof x.text === "string").map((x: any) => ({ id: x.id, text: x.text })),
  };
  if (card.type === "file") return { type: "file", workspace: string(card.workspace), path: string(card.path), name: string(card.name), mime_type: string(card.mime_type), size: number(card.size) };
  if (card.type === "image") return { type: "image", workspace: string(card.workspace), path: string(card.path), alt: string(card.alt) };
  if (card.type === "link") return { type: "link", url: string(card.url), title: string(card.title), summary: string(card.summary) };
  if (card.type === "permission") return { type: "permission", permission: string(card.permission), why: string(card.why) };
  return null;
}

/**
 * The attachments of a message. A file of a body is a reference ({workspace, path}); anything else is bytes carried in the
 * message: base64 text, or (when large) a reference to the blob that holds it, and is opened from the ledger on demand.
 */
function safeAttachments(value: any, messageId: string) {
  if (!Array.isArray(value)) return [];
  const safe: DisplayFact[] = [];
  value.forEach((item: any, index: number) => {
    if (!object(item) || typeof item.name !== "string" || !item.name || typeof item.mime_type !== "string" || !item.mime_type) return;
    if (typeof item.workspace === "string" && item.workspace && typeof item.path === "string" && item.path && !item.path.startsWith("/") && !item.path.split("/").includes("..") && Number.isSafeInteger(item.size) && item.size >= 0) {
      safe.push({ workspace: item.workspace, path: item.path, name: item.name, mime_type: item.mime_type, size: item.size });
      return;
    }
    if (typeof messageId !== "string" || !messageId) return;
    if (isBlob(item.data)) {
      // The blob is the base64 text of the file.
      safe.push({ source: "inline", message_id: messageId, index, name: item.name, mime_type: item.mime_type, size: Math.floor(Number(item.data.size) * 3 / 4) });
      return;
    }
    if (typeof item.data !== "string" || item.data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0) return;
    const size = item.data.length / 4 * 3 - (item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0);
    safe.push({ source: "inline", message_id: messageId, index, name: item.name, mime_type: item.mime_type, size });
  });
  return safe;
}

/** The ask's options as the card draws them: its own, or yes/no for a confirmation that gave none (SPEC-03 §5.1). */
function askOptions(b: any) {
  const given = Array.isArray(b.options) ? b.options : null;
  if (given) {
    const valid = given.filter((x: any) => object(x) && typeof x.id === "string" && typeof x.label === "string");
    return { options: valid.map((x: any) => ({ id: x.id, label: x.label })), valid: valid.length === given.length };
  }
  if (b.human_kind === "confirmation") return { options: [{ id: "yes", label: "是" }, { id: "no", label: "否" }], valid: true };
  return { options: [], valid: false };
}

export function safeRecord(m: any): DisplayFact | null {
  if (!object(m) || !Number.isSafeInteger(m.seq) || m.seq < 1 || typeof m.id !== "string" || !m.id || typeof m.word !== "string" || !object(m.body)) return null;
  const b = m.body;
  const base = { seq: m.seq, id: m.id, ts: number(m.ts), turn: turnId(m.turn) ? m.turn : "", thread: string(m.thread) };

  // A turn of an agent, and its native tool calls (the agents module reports them as events).
  if (m.kind === "event" && isAgent(m.from)) {
    if (m.word === "turn.started" && turnId(b.turn)) return { ...base, type: "turn.start", turn: b.turn, lane: string(b.lane), ids: strings(b.ids), agent: m.from };
    if (m.word === "turn.ended" && turnId(b.turn)) return { ...base, type: "turn.end", turn: b.turn, outcome: outcomeOf(b.outcome) };
    if (m.word === "agent.tool" && turnId(b.turn) && typeof b.name === "string" && (b.phase === "start" || b.phase === "end"))
      return { ...base, type: "tool", turn: b.turn, name: b.name, phase: b.phase, summary: activityText(b.summary, 100), ok: b.ok !== false };
    return null;
  }

  if (m.kind === "request" && m.word === "say" && (typeof b.text === "string" || isBlob(b.text) || Array.isArray(b.attachments))) {
    const body = textField(b.text);
    if (isAgent(m.to) && m.from === OWNER)
      return { ...base, type: "owner.say", to: m.to, ...body, attachments: safeAttachments(b.attachments, m.id), origin: object(m.origin) ? { client: string(m.origin.client), label: string(m.origin.label) } : null, in_reply_to: string(b.in_reply_to), option_id: string(b.option_id) };
    if (m.to === OWNER && publisher(m.from))
      return { ...base, type: "agent.say", from: m.from, ...body, attachments: safeAttachments(b.attachments, m.id), kind: string(b.kind) };
  }
  if (m.kind === "request" && m.to === OWNER && publisher(m.from)) {
    if (m.word === "react" && typeof b.message_id === "string" && typeof b.emoji === "string") return { ...base, type: "react", message_id: b.message_id, emoji: b.emoji };
    if (m.word === "show") {
      // A card the agent wrote (A2UI): what it shows now is kept with the card (service:history reads it); here only which card.
      if (b.a2ui !== undefined) return { ...base, type: "show", card: { type: "a2ui", id: typeof b.id === "string" && b.id ? b.id : m.id, text: textField(b.text).text } };
      const card = safeCard(b.card); return card ? { ...base, type: "show", card } : null;
    }
    if (m.word === "form" && typeof b.title === "string") return { ...base, type: "show", card: { type: "a2ui", id: m.id, text: `需要你填：${b.title}`, form: true } };
    if (m.word === "ask" && typeof b.title === "string") {
      const { options, valid } = askOptions(b);
      const asked = number(m.ts) ?? 0;
      // No end given: 24 hours; never more than 7 days (SPEC-03 §5.1).
      const expires = Math.min(number(b.expires_at) ?? asked + DAY, asked + 7 * DAY);
      return {
        ...base, type: "ask", from: m.from, title: b.title, detail: string(b.detail), expires_at: expires,
        human_kind: b.human_kind === "confirmation" ? "confirmation" : "question", allow_custom: b.human_kind !== "confirmation" && b.allow_custom === true,
        // The gate's unabridged snapshot of what it is asking about; nobody else's text is shown as an original.
        ...(m.from === "service:gate" && object(b.source) && (typeof b.source.body_full === "string" || isBlob(b.source.body_full)) ? { original: textField(b.source.body_full).text, ...(textField(b.source.body_full).full ? { original_full: textField(b.source.body_full).full } : {}) } : {}),
        options_valid: valid && options.length > 0, options,
      };
    }
  }
  // An answer to a question: the owner's choice, or how the question ended without one.
  if (m.kind === "response" && m.word === "ask" && typeof m.reply_to === "string")
    return { ...base, type: "ask.answer", reply_to: m.reply_to, choice: b.ok === true ? string(b.result?.data?.choice) : "", error: b.ok === false && object(b.error) ? string(b.error.code) : "", answer_text: b.ok === true ? textField(b.result?.data?.text).text : "", ...(b.ok === true && textField(b.result?.data?.text).full ? { answer_full: textField(b.result?.data?.text).full } : {}) };
  // The agent took a say in.
  if (m.kind === "response" && m.word === "say" && isAgent(m.from) && m.to === OWNER && typeof m.reply_to === "string")
    return { ...base, type: "say.result", reply_to: m.reply_to, accepted: b.ok === true && b.result?.data?.accepted === true };
  // An app's entry card: one small row that opens the app.
  if (m.kind === "event" && /^app:[a-z][a-z0-9-]{0,47}$/.test(m.from) && m.to === OWNER && typeof b.title === "string" && b.title)
    return { ...base, type: "app.card", app: m.from.slice(4), name: string(b.name) || m.from.slice(4), title: b.title, text: string(b.text) };
  // What an agent asked of the members during a turn, and the answers. Only selected display metadata is retained;
  // details are fetched on demand (service:history/activity).
  if (m.kind === "request" && turnId(m.turn) && isAgent(m.from) && memberId(m.to) && m.to !== OWNER)
    return { ...base, type: "activity.request", to: m.to, word: m.word, action: activityAction(m.to, m.word, b) };
  if (m.kind === "response" && typeof m.reply_to === "string" && typeof b.ok === "boolean")
    return { ...base, type: "activity.response", reply_to: m.reply_to, result: activityResult(b.ok === true ? (object(b.result?.data) ? b.result.data : {}) : b), ok: b.ok, error: b.ok === false && object(b.error) ? string(b.error.code) : "" };
  return null;
}

const agentTitle = (agent: string) => `${agent.slice(6)} 在后台工作`;

export function projectRecords(records: DisplayFact[]): ConversationView {
  const view = initialView();
  view._records = records;
  const delivery = new Map();
  const asksById = new Map(records.filter((r) => r.type === "ask").map((r) => [r.id, r]));
  const cardsById = new Map(records.filter((r) => r.type === "show" && r.card.type === "options").map((r) => [r.id, r]));
  const answers = new Map();
  const optionReplies = new Map();
  const reactions = new Map();
  const ownerTitles = new Map(records.filter((r) => r.type === "owner.say").map((r) => [r.id, r.text]));
  const activities = new Map<string, ActivitySteps>();
  /** Native tool calls of a turn that are still open, oldest first. */
  const openTools = new Map();
  for (const r of records) {
    if (r.type === "say.result" && r.accepted && delivery.get(r.reply_to) !== "read") delivery.set(r.reply_to, "delivered");
    if (r.type === "turn.start") for (const id of r.ids) delivery.set(id, "read");
    if (r.type === "ask.answer") {
      const ask = asksById.get(r.reply_to);
      if (ask && r.seq > ask.seq && !answers.has(ask.id)) answers.set(ask.id, r);
    }
    if (r.type === "react") reactions.set(r.message_id, [...(reactions.get(r.message_id) || []), { id: r.id, emoji: r.emoji }]);
  }
  for (const r of records) if (r.type === "owner.say" && r.in_reply_to && r.option_id) {
    const card = cardsById.get(r.in_reply_to);
    if (!card || r.seq <= card.seq || optionReplies.has(card.id)) continue;
    const options = card.card.options;
    if (new Set(options.map((option: any) => option.id)).size !== options.length || options.some((option: any) => option.id === "__custom")) continue;
    const offered = options.some((option: any) => option.id === r.option_id && option.text === r.text);
    const custom = r.option_id === "__custom" && card.card.allow_custom && r.text.length > 0;
    if (offered || custom) optionReplies.set(card.id, r.option_id);
  }
  for (const r of records) {
    if (r.type === "owner.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "owner", to: r.to, text: r.text, full: r.full, attachments: r.attachments, delivery: delivery.get(r.id) || "sent", origin: r.origin, reactions: reactions.get(r.id) || [] });
    else if (r.type === "agent.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "agent", from: r.from, text: r.text, full: r.full, attachments: r.attachments, kind: r.kind, group: r.turn || null, reactions: reactions.get(r.id) || [] });
    else if (r.type === "app.card") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "card", side: "agent", card: { type: "app", app: r.app, name: r.name, title: r.title, text: r.text }, reactions: [] });
    else if (r.type === "show") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "card", side: "agent", card: r.card, locked: r.card.type === "options" && optionReplies.has(r.id), selected_option_id: optionReplies.get(r.id) || null, reactions: reactions.get(r.id) || [] });
    else if (r.type === "ask") {
      // Any response to the question closes the card: the owner's choice, a timeout, or a cancel.
      const answer = answers.get(r.id);
      const state = !answer ? "pending" : answer.error === "timeout" ? "expired" : answer.choice ? "answered" : "closed";
      const ask = { id: r.id, seq: r.seq, ts: r.ts, from: r.from, title: r.title, detail: r.detail, human_kind: r.human_kind, allow_custom: r.allow_custom,
        answer_text: answer?.answer_text, ...(answer?.answer_full ? { answer_full: answer.answer_full } : {}), ...(typeof r.original === "string" ? { original: r.original, ...(r.original_full ? { original_full: r.original_full } : {}) } : {}), options: r.options, options_valid: r.options_valid,
        expires_at: r.expires_at, state, choice: answer?.choice || null };
      view.asks.push(ask);
      view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "ask", side: "agent", ask, reactions: reactions.get(r.id) || [] });
    } else if (r.type === "turn.start") {
      const batch = r.ids.map((id: string) => ownerTitles.get(id)).filter(Boolean);
      const excerpt = batch.length ? [...batch[0]].slice(0, 48).join("") : "";
      const background = r.lane !== "front";
      view.turns[r.turn] = { title: background ? agentTitle(r.agent) : excerpt ? `${excerpt}${batch.length > 1 ? ` · ${batch.length} 条` : ""}` : "对话",
        background, started: r.ts, steps: [], agent: r.agent, lane: r.lane };
      activities.set(r.turn, new ActivitySteps());
      openTools.set(r.turn, []);
    } else if (r.type === "turn.end") {
      if (view.turns[r.turn]) { view.turns[r.turn].ended = r.ts; view.turns[r.turn].outcome = r.outcome; }
    } else if (r.type === "tool" && view.turns[r.turn]) {
      const steps = view.turns[r.turn].steps;
      if (r.phase === "start") {
        const step: DisplayFact = { seq: r.seq, ts: r.ts, label: r.summary || activityText(r.name, 100), state: "pending" };
        steps.push(step);
        openTools.get(r.turn)?.push({ name: r.name, step });
      } else {
        const open = openTools.get(r.turn) ?? [];
        const at = open.findIndex((item: any) => item.name === r.name);
        if (at >= 0) { const [{ step }] = open.splice(at, 1); step.state = r.ok ? "ok" : "failed"; step.ended = r.ts; }
      }
    } else if (r.type === "activity.request" && view.turns[r.turn]) activities.get(r.turn)?.request(r.id, r.ts, r.action);
    else if (r.type === "activity.response") {
      for (const activity of activities.values()) activity.response(r.reply_to, r.ts,
        r.result.state === "accepted" ? { status: "accepted", request_id: r.result.receipt } : r.result.state === "unconfirmed" ? { truncated: true } : r.result.state === "waiting_owner" ? { status: "waiting_owner" } : { ok: r.result.state !== "failed" });
    }
  }
  for (const [id, activity] of activities) view.turns[id].steps = [...view.turns[id].steps, ...activity.visible()].sort((a, b) => a.ts - b.ts);
  view.conversation.sort((a, b) => a.seq - b.seq);
  view.presence = presenceOf(view);
  return view;
}

/** What the presence bar says: working while a front turn is open, waiting for you while a question is open, else here. */
function presenceOf(view: ConversationView) {
  const open = Object.values(view.turns).filter((turn) => turn.background !== true && !Number.isFinite(turn.ended)).sort((a, b) => b.started - a.started)[0];
  if (open) {
    const doing = open.steps.filter((step: DisplayFact) => !step.summary && step.state === "pending").at(-1);
    return doing ? { state: "working", text: doing.label, avatar: "focused" } : { state: "thinking", text: "", avatar: "thinking" };
  }
  if (view.asks.some((ask) => ask.state === "pending" && ask.expires_at > Date.now())) return { state: "waiting_you", text: "", avatar: "listening" };
  return { state: "idle", text: "", avatar: "default" };
}


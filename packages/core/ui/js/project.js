// Pure ledger projection. _records contains only selected display-safe facts,
// never tool arguments, raw results, credentials, or stream control frames.
const FACE = {
  idle: "default", resting: "resting", listening: "listening",
  thinking: "thinking", working: "focused", done: "success", waiting_you: "listening",
};

export function initialView() {
  const view = {
    presence: { state: "unknown", text: "", avatar: "default" },
    conversation: [], turns: {}, asks: [], timers: [],
    self: { changed: [] }, held: 0,
  };
  Object.defineProperty(view, "_records", { value: [], writable: true });
  return view;
}

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const string = (x) => typeof x === "string" ? x : "";
const number = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
const strings = (x) => Array.isArray(x) ? x.filter((v) => typeof v === "string") : [];
const knownState = (x) => Object.hasOwn(FACE, x);
const turnId = (x) => typeof x === "string" && /^[tr]_[A-Za-z0-9_-]+$/.test(x);
const ownerPublisher = (from) => ["agent:main", "service:gate", "service:work"].includes(from);

function safeCard(card) {
  if (!object(card)) return null;
  if (card.type === "options" && Array.isArray(card.options)) return {
    type: "options", prompt: string(card.prompt), allow_custom: card.allow_custom === true,
    options: card.options.filter((x) => object(x) && typeof x.id === "string" && typeof x.text === "string").map((x) => ({ id: x.id, text: x.text })),
  };
  if (card.type === "file") return { type: "file", workspace: string(card.workspace), path: string(card.path), name: string(card.name), mime_type: string(card.mime_type), size: number(card.size) };
  if (card.type === "image") return { type: "image", workspace: string(card.workspace), path: string(card.path), alt: string(card.alt) };
  if (card.type === "link") return { type: "link", url: string(card.url), title: string(card.title), summary: string(card.summary) };
  if (card.type === "permission") return { type: "permission", permission: string(card.permission), why: string(card.why) };
  return null;
}

function record(m) {
  if (!object(m) || !Number.isSafeInteger(m.seq) || m.seq < 1 || typeof m.id !== "string" || !m.id || typeof m.word !== "string" || !object(m.body)) return null;
  const b = m.body;
  const base = { seq: m.seq, id: m.id, ts: number(m.ts), turn: turnId(m.turn) ? m.turn : "" };
  if (m.kind === "event" && m.from === "agent:main") {
    if (m.word === "status" && knownState(b.state)) return { ...base, type: "status", state: b.state, text: string(b.text) };
    if (m.word === "received") return { ...base, type: "received", ids: strings(b.ids) };
    if (m.word === "read") return { ...base, type: "read", ids: strings(b.ids) };
    if (m.word === "turn.start" && turnId(b.turn)) return { ...base, type: "turn.start", turn: b.turn, ids: strings(b.ids) };
    if (m.word === "turn.end" && turnId(b.turn)) return { ...base, type: "turn.end", turn: b.turn, reason: string(b.reason) };
  }
  if (m.kind === "request" && m.word === "say" && typeof b.text === "string") {
    if (m.to === "agent:main" && m.from === "person:owner") return { ...base, type: "owner.say", text: b.text, origin: object(m.origin) ? { screen: string(m.origin.screen), label: string(m.origin.label) } : null, in_reply_to: string(b.in_reply_to), option_id: string(b.option_id) };
    if (m.to === "person:owner" && ownerPublisher(m.from)) return { ...base, type: "agent.say", from: m.from, text: b.text, kind: string(b.kind) };
  }
  if (m.kind === "request" && m.to === "person:owner" && ownerPublisher(m.from)) {
    if (m.word === "react" && typeof b.message_id === "string" && typeof b.emoji === "string") return { ...base, type: "react", message_id: b.message_id, emoji: b.emoji };
    if (m.word === "show") { const card = safeCard(b.card); return card ? { ...base, type: "show", card } : null; }
    if (m.word === "ask" && typeof b.title === "string" && Array.isArray(b.options)) return {
      ...base, type: "ask", title: b.title, detail: string(b.detail), expires_at: number(b.expires_at),
      options: b.options.filter((x) => object(x) && typeof x.id === "string" && typeof x.label === "string").map((x) => ({ id: x.id, label: x.label })),
    };
  }
  if (m.kind === "response" && m.word === "ask" && m.from === "person:owner" && ownerPublisher(m.to) && typeof m.reply_to === "string" && object(b)) {
    const choice = b.ok === true && object(b.result) ? string(b.result.choice) : "";
    const error = b.ok === false && object(b.error) ? string(b.error.code) : "";
    return { ...base, type: "ask.answer", reply_to: m.reply_to, choice, error };
  }
  if (m.kind === "response" && m.from === "service:clock" && m.word === "list" && b.ok === true && object(b.result) && Array.isArray(b.result.timers)) return {
    ...base, type: "clock.list", timers: b.result.timers.filter(object).map((t) => ({ id: string(t.id), text: string(t.text), fire_at: number(t.fire_at), repeat_seconds: number(t.repeat_seconds) })),
  };
  if (m.kind === "event" && m.from === "service:post" && m.to === "person:owner" && m.word === "post.changed" && Number.isSafeInteger(b.held) && b.held >= 0) return { ...base, type: "post.changed", held: b.held };
  if (m.kind === "event" && m.from === "service:self" && m.word === "self.changed" && typeof b.path === "string") return { ...base, type: "self.changed", path: b.path, by: string(b.by), summary: string(b.summary), version: number(b.version) };
  if (m.kind === "event" && m.from === "service:work") {
    if (m.word === "run.start" && turnId(b.run)) return { ...base, type: "run.start", turn: b.run };
    if (m.word === "run.end" && turnId(b.run)) return { ...base, type: "run.end", turn: b.run, outcome: string(b.outcome) };
  }
  if (m.kind === "event" && m.from === "service:gate" && ["gate.asked", "gate.passed", "gate.denied"].includes(m.word)) return { ...base, type: m.word };
  return null;
}

function project(records) {
  const view = initialView();
  view._records = records;
  const delivery = new Map();
  const answers = new Map();
  const optionReplies = new Set();
  const reactions = new Map();
  for (const r of records) {
    if (r.type === "received" || r.type === "read") for (const id of r.ids) delivery.set(id, r.type === "read" ? "read" : delivery.get(id) === "read" ? "read" : "delivered");
    if (r.type === "ask.answer") answers.set(r.reply_to, r);
    if (r.type === "owner.say" && r.in_reply_to && r.option_id) optionReplies.add(r.in_reply_to);
    if (r.type === "react") reactions.set(r.message_id, [...(reactions.get(r.message_id) || []), { id: r.id, emoji: r.emoji }]);
  }
  for (const r of records) {
    if (r.type === "status") {
      view.presence = { state: r.state, text: r.text, avatar: FACE[r.state] };
      if (r.state === "working" && r.turn && view.turns[r.turn]) view.turns[r.turn].steps.push({ seq: r.seq, ts: r.ts, label: r.text || "在忙" });
    } else if (r.type === "owner.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "owner", text: r.text, delivery: delivery.get(r.id) || "sent", origin: r.origin, reactions: reactions.get(r.id) || [] });
    else if (r.type === "agent.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "agent", from: r.from, text: r.text, kind: r.kind, group: r.turn || null, reactions: reactions.get(r.id) || [] });
    else if (r.type === "show") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "card", side: "agent", card: r.card, locked: r.card.type === "options" && optionReplies.has(r.id), reactions: reactions.get(r.id) || [] });
    else if (r.type === "ask") {
      const answer = answers.get(r.id);
      const state = !answer ? "pending" : answer.choice ? "answered" : answer.error === "timeout" ? "expired" : "closed";
      const ask = { id: r.id, seq: r.seq, ts: r.ts, title: r.title, detail: r.detail, options: r.options, expires_at: r.expires_at, state, choice: answer?.choice || null };
      view.asks.push(ask);
      view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "ask", side: "agent", ask, reactions: reactions.get(r.id) || [] });
    } else if (r.type === "turn.start" || r.type === "run.start") {
      view.turns[r.turn] = { title: r.type === "run.start" ? "后台任务" : "对话", started: r.ts, steps: [] };
    } else if (r.type === "turn.end" || r.type === "run.end") {
      if (view.turns[r.turn]) { view.turns[r.turn].ended = r.ts; view.turns[r.turn].outcome = r.reason || r.outcome; }
    } else if (r.type === "clock.list") view.timers = r.timers;
    else if (r.type === "post.changed") view.held = r.held;
    else if (r.type === "self.changed") view.self.changed.push({ path: r.path, by: r.by, ts: r.ts, summary: r.summary, version: r.version });
    else if (r.type.startsWith("gate.") && r.turn && view.turns[r.turn]) view.turns[r.turn].steps.push({ seq: r.seq, ts: r.ts, label: r.type === "gate.asked" ? "等待确认" : r.type === "gate.passed" ? "已确认" : "未获确认" });
  }
  return view;
}

/** Folds one ledger Message. Unnumbered SSE control frames and unknown words are ignored. */
export function fold(state, message) {
  const current = state && Array.isArray(state._records) ? state : initialView();
  const next = record(message);
  if (!next || current._records.some((r) => r.id === next.id || r.seq === next.seq)) return current;
  const records = [...current._records, next].sort((a, b) => a.seq - b.seq);
  return project(records);
}

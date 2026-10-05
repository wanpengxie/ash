// Pure ledger projection. _records contains only selected display-safe facts,
// never tool arguments, raw results, credentials, or stream control frames.
import { isMessageSummaryV2 } from "../../../sdk/src/api.ts";
import { postDeliverySnapshotErrors } from "../../../sdk/src/words.ts";
import { faceForStatus } from "./presence.js";
import { activityAction, activityResult, activityText, ActivitySteps } from "../../../sdk/src/activity.ts";

export function initialView() {
  const view = {
    presence: { state: "unknown", text: "", avatar: "default" },
    conversation: [], turns: {}, asks: [], timers: [],
    self: { changed: [] }, held: 0,
  };
  Object.defineProperty(view, "_records", { value: [], writable: true });
  Object.defineProperty(view, "_postSnapshots", { value: new Map(), writable: true });
  return view;
}

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const string = (x) => typeof x === "string" ? x : "";
const number = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
const strings = (x) => Array.isArray(x) ? x.filter((v) => typeof v === "string") : [];
const knownState = (x) => faceForStatus(x) !== null;
const turnId = (x) => typeof x === "string" && /^[tr]_[A-Za-z0-9_-]+$/.test(x);
const memberId = (x) => typeof x === "string" && /^(agent|worker|device|service|person):[A-Za-z0-9_-]+$/.test(x);
/** How another agent is named in the activity. */
const AGENT_TITLES = { "agent:keeper": "整理者在后台整理" };
const agentTitle = (id) => AGENT_TITLES[id] || `${id.slice(6)} 在后台工作`;
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

function safeAttachments(value, messageId, inline = []) {
  if (!Array.isArray(value)) return [];
  const safe = [];
  value.forEach((item, index) => {
    if (!object(item) || typeof item.name !== "string" || !item.name || typeof item.mime_type !== "string" || !item.mime_type) return;
    if (typeof item.workspace === "string" && item.workspace && typeof item.path === "string" && item.path && !item.path.startsWith("/") && !item.path.split("/").includes("..") && Number.isSafeInteger(item.size) && item.size >= 0) {
      safe.push({ workspace: item.workspace, path: item.path, name: item.name, mime_type: item.mime_type, size: item.size });
      return;
    }
    const descriptor = Array.isArray(inline) ? inline.find((entry) => entry.index === index) : null;
    if (descriptor && typeof messageId === "string" && messageId && descriptor.name === item.name && descriptor.mime_type === item.mime_type && Number.isSafeInteger(descriptor.size) && descriptor.size >= 0) {
      safe.push({ source: "inline", message_id: messageId, index, name: item.name, mime_type: item.mime_type, size: descriptor.size });
      return;
    }
    if (typeof messageId !== "string" || !messageId || typeof item.data !== "string" || item.data.length === 0 || item.data.length > 28 * 1024 * 1024) return;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0) return;
    const size = item.data.length / 4 * 3 - (item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0);
    safe.push({ source: "inline", message_id: messageId, index, name: item.name, mime_type: item.mime_type, size });
  });
  return safe;
}

function legacyMetadata(value, m) {
  if (!object(value) || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq !== m.seq || typeof value.workspace !== "string" || !value.workspace || typeof value.member !== "string" || value.member !== m.from || !/^[^:]+:.+$/.test(value.member)) return null;
  const inboundToAgent = typeof m.to === "string" && /^agent:[^:]+$/.test(m.to);
  const agentToOwner = /^agent:[^:]+$/.test(m.from) && m.to === "person:owner";
  return inboundToAgent || agentToOwner ? { seq: value.seq, workspace: value.workspace, member: value.member } : null;
}

function record(m) {
  if (!object(m) || !Number.isSafeInteger(m.seq) || m.seq < 1 || typeof m.id !== "string" || !m.id || typeof m.word !== "string" || (m.summary === true ? !isMessageSummaryV2(m) : !object(m.body))) return null;
  const b = m.summary === true ? m.body_summary : m.body;
  const base = { seq: m.seq, id: m.id, ts: number(m.ts), turn: turnId(m.turn) ? m.turn : "" };
  // Another agent's turns appear in the activity, marked with who did them; its status and receipts do not.
  if (m.kind === "event" && /^agent:[a-z][a-z0-9_-]*$/.test(m.from) && m.from !== "agent:main") {
    if (m.word === "turn.start" && turnId(b.turn)) return { ...base, type: "turn.start", turn: b.turn, ids: strings(b.ids), agent: m.from };
    if (m.word === "turn.end" && turnId(b.turn)) return { ...base, type: "turn.end", turn: b.turn, reason: string(b.reason), agent: m.from };
    return null;
  }
  if (m.kind === "event" && m.from === "agent:main") {
    if (m.word === "activity.summary" && turnId(m.turn) && typeof b.text === "string") return { ...base, type: "activity.summary", text: activityText(b.text, 160) };
    if (m.word === "status" && knownState(b.state)) return { ...base, type: "status", state: b.state, text: string(b.text) };
    if (m.word === "received") return { ...base, type: "received", ids: strings(b.ids) };
    if (m.word === "read") return { ...base, type: "read", ids: strings(b.ids) };
    if (m.word === "turn.start" && turnId(b.turn)) return { ...base, type: "turn.start", turn: b.turn, ids: strings(b.ids) };
    if (m.word === "turn.end" && turnId(b.turn)) return { ...base, type: "turn.end", turn: b.turn, reason: string(b.reason) };
  }
  if (m.kind === "request" && m.word === "say" && typeof b.text === "string") {
    if (Object.hasOwn(b, "legacy")) {
      const legacy = legacyMetadata(b.legacy, m);
      return legacy ? { ...base, type: "legacy.say", from: m.from, to: m.to, side: m.from === "person:owner" ? "owner" : m.to === "person:owner" ? "agent" : "inbound", text: b.text, attachments: safeAttachments(b.attachments), legacy } : null;
    }
    if (m.to === "agent:main" && m.from === "person:owner") return { ...base, type: "owner.say", text: b.text, attachments: safeAttachments(b.attachments, m.id, m.inline_attachments), origin: object(m.origin) ? { screen: string(m.origin.screen), label: string(m.origin.label) } : null, in_reply_to: string(b.in_reply_to), option_id: string(b.option_id) };
    if (m.to === "person:owner" && ownerPublisher(m.from)) return { ...base, type: "agent.say", from: m.from, text: b.text, attachments: safeAttachments(b.attachments, m.id, m.inline_attachments), kind: string(b.kind) };
  }
  if (m.kind === "request" && m.to === "person:owner" && ownerPublisher(m.from)) {
    if (m.word === "react" && typeof b.message_id === "string" && typeof b.emoji === "string") return { ...base, type: "react", message_id: b.message_id, emoji: b.emoji };
    if (m.word === "show") { const card = safeCard(b.card); return card ? { ...base, type: "show", card } : null; }
    if (m.word === "ask" && typeof b.title === "string" && Array.isArray(b.options)) return {
      ...base, type: "ask", from: m.from, title: b.title, detail: string(b.detail), expires_at: number(b.expires_at),
      ...(m.from === "service:gate" && object(b.source) && typeof b.source.body_full === "string" ? { original: b.source.body_full } : {}),
      options_valid: b.options.every((x) => object(x) && typeof x.id === "string" && typeof x.label === "string"),
      options: b.options.filter((x) => object(x) && typeof x.id === "string" && typeof x.label === "string").map((x) => ({ id: x.id, label: x.label })),
    };
  }
  if (m.kind === "response" && m.word === "ask" && m.from === "person:owner" && ownerPublisher(m.to) && typeof m.reply_to === "string" && object(b)) {
    const choice = b.ok === true && object(b.result) ? string(b.result.choice) : "";
    const error = b.ok === false && object(b.error) ? string(b.error.code) : "";
    return { ...base, type: "ask.answer", reply_to: m.reply_to, to: m.to, choice, error };
  }
  if (m.kind === "response" && m.word === "say" && m.from === "agent:main" && m.to === "person:owner" && typeof m.reply_to === "string") return {
    ...base, type: "say.result", reply_to: m.reply_to, accepted: b.ok === true && object(b.result) && b.result.accepted === true,
  };
  if (m.kind === "response" && m.from === "service:clock" && m.word === "list" && b.ok === true && object(b.result) && Array.isArray(b.result.timers)) return {
    ...base, type: "clock.list", timers: b.result.timers.filter((t) => object(t) && typeof t.id === "string" && t.id && Number.isSafeInteger(t.next) && t.next >= 0)
      .map((t) => ({ id: t.id, next: t.next, every: Number.isSafeInteger(t.every) && t.every >= 60 ? t.every : null,
        to: memberId(t.to) ? t.to : null, word: string(t.word), label: string(t.label), blocked: string(t.blocked) || null })),
  };
  if (m.kind === "event" && m.from === "service:post" && m.to === "person:owner" && m.word === "post.changed" && Number.isSafeInteger(b.held) && b.held >= 0) return { ...base, type: "post.changed", held: b.held };
  if (m.kind === "event" && m.from === "service:post" && m.to === "person:owner" && m.word === "post.delivery" && typeof b.message_id === "string" && b.message_id && ["held", "released", "dropped"].includes(b.state))
    return { ...base, type: "post.delivery", message_id: b.message_id, state: b.state };
  if (m.kind === "event" && m.from === "service:self" && m.word === "self.changed" && typeof b.path === "string") return { ...base, type: "self.changed", path: b.path, by: string(b.by), summary: string(b.summary), version: number(b.version) };
  if (m.kind === "event" && m.from === "service:work") {
    if (m.word === "run.start" && turnId(b.run) && (m.turn === undefined || m.turn === b.run)) return { ...base, type: "run.start", turn: b.run, flow: string(b.flow), trigger: string(b.trigger) };
    if (m.word === "run.step" && turnId(b.run) && m.turn === b.run && typeof b.step === "string" && /^[a-z][a-z0-9._-]{0,47}$/.test(b.step) &&
      ["started", "done", "failed", "skipped"].includes(b.state)) return { ...base, type: "run.step", turn: b.run, step: b.step, state: b.state };
    if (m.word === "run.end" && turnId(b.run) && (m.turn === undefined || m.turn === b.run)) return { ...base, type: "run.end", turn: b.run, outcome: string(b.outcome) };
  }
  if (m.kind === "event" && m.from === "service:gate" && ["gate.asked", "gate.passed", "gate.denied"].includes(m.word)) return { ...base, type: m.word, requestId: string(b.request_id) };
  // Only selected display metadata is retained. Details are owner-authenticated and fetched on demand.
  if (m.kind === "request" && turnId(m.turn) && (/^agent:[a-z][a-z0-9_-]*$/.test(m.from) || m.from === "service:work") && memberId(m.to) && m.to !== "person:owner")
    return { ...base, type: "activity.request", to: m.to, word: m.word, action: activityAction(m.to, m.word, b) };
  if (m.kind === "response" && typeof m.reply_to === "string" && object(b) && typeof b.ok === "boolean")
    return { ...base, type: "activity.response", reply_to: m.reply_to, result: activityResult(b), ok: b.ok, error: b.ok === false && object(b.error) ? string(b.error.code) : "" };
  return null;
}

function project(records, snapshots = new Map()) {
  const view = initialView();
  view._records = records;
  view._postSnapshots = snapshots;
  const delivery = new Map();
  const asksById = new Map(records.filter((r) => r.type === "ask").map((r) => [r.id, r]));
  const cardsById = new Map(records.filter((r) => r.type === "show" && r.card.type === "options").map((r) => [r.id, r]));
  const answers = new Map();
  const optionReplies = new Map();
  const reactions = new Map();
  const ownerTitles = new Map(records.filter((r) => r.type === "owner.say").map((r) => [r.id, r.text]));
  const activities = new Map();
  const postStates = new Map(snapshots);
  for (const r of records) {
    if (r.type === "post.delivery" && (r.state === "dropped" || postStates.get(r.message_id)?.state !== "dropped" && (!postStates.has(r.message_id) || postStates.get(r.message_id).version_seq <= r.seq)))
      postStates.set(r.message_id, { state: r.state, version_seq: r.seq });
    if (r.type === "received" || r.type === "read") for (const id of r.ids) delivery.set(id, r.type === "read" ? "read" : delivery.get(id) === "read" ? "read" : "delivered");
    if (r.type === "ask.answer") {
      const ask = asksById.get(r.reply_to);
      if (ask && r.seq > ask.seq && r.to === ask.from && !answers.has(ask.id) && (ask.options.some((option) => option.id === r.choice) || ["timeout", "cancelled"].includes(r.error))) answers.set(ask.id, r);
    }
    if (r.type === "react") reactions.set(r.message_id, [...(reactions.get(r.message_id) || []), { id: r.id, emoji: r.emoji }]);
  }
  for (const r of records) if (r.type === "owner.say" && r.in_reply_to && r.option_id) {
    const card = cardsById.get(r.in_reply_to);
    if (!card || r.seq <= card.seq || optionReplies.has(card.id)) continue;
    const options = card.card.options;
    if (new Set(options.map((option) => option.id)).size !== options.length || options.some((option) => option.id === "__custom")) continue;
    const offered = options.some((option) => option.id === r.option_id && option.text === r.text);
    const custom = r.option_id === "__custom" && card.card.allow_custom && r.text.length > 0;
    if (offered || custom) optionReplies.set(card.id, r.option_id);
  }
  for (const r of records) {
    if (r.type === "status") {
      view.presence = { state: r.state, text: r.text, avatar: faceForStatus(r.state) };
      // Status pulses are presence, not additional work steps.
    } else if (r.type === "legacy.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: r.side, from: r.from, to: r.to, text: r.text, attachments: r.attachments, legacy: r.legacy, readOnly: true, reactions: [] });
    else if (r.type === "owner.say") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "owner", text: r.text, attachments: r.attachments, delivery: delivery.get(r.id) || "sent", origin: r.origin, reactions: reactions.get(r.id) || [] });
    else if (r.type === "agent.say") {
      if (["offer", "heads_up"].includes(r.kind) && postStates.get(r.id)?.state !== "released") continue;
      view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "say", side: "agent", from: r.from, text: r.text, attachments: r.attachments, kind: r.kind, group: r.turn || null, reactions: reactions.get(r.id) || [] });
    }
    else if (r.type === "show") view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "card", side: "agent", card: r.card, locked: r.card.type === "options" && optionReplies.has(r.id), selected_option_id: optionReplies.get(r.id) || null, reactions: reactions.get(r.id) || [] });
    else if (r.type === "ask") {
      const answer = answers.get(r.id);
      const state = !answer ? "pending" : answer.error === "timeout" || answer.choice === "deny" && answer.ts >= r.expires_at
        ? "expired" : answer.choice ? "answered" : "closed";
      const ask = { id: r.id, seq: r.seq, ts: r.ts, from: r.from, title: r.title, detail: r.detail, ...(typeof r.original === "string" ? { original: r.original } : {}), options: r.options, options_valid: r.options_valid, expires_at: r.expires_at, state, choice: answer?.choice || null };
      view.asks.push(ask);
      view.conversation.push({ id: r.id, seq: r.seq, ts: r.ts, type: "ask", side: "agent", ask, reactions: reactions.get(r.id) || [] });
    } else if (r.type === "turn.start" || r.type === "run.start") {
      const batch = r.type === "turn.start" ? r.ids.map((id) => ownerTitles.get(id)).filter(Boolean) : [];
      const excerpt = batch.length ? [...batch[0]].slice(0, 48).join("") : "";
      const title = r.type === "run.start" ? r.flow || "后台任务" : r.agent ? agentTitle(r.agent) : excerpt ? `${excerpt}${batch.length > 1 ? ` · ${batch.length} 条` : ""}` : "对话";
      view.turns[r.turn] = { title, background: r.type === "run.start" || Boolean(r.agent), started: r.ts, steps: [], ...(r.agent ? { agent: r.agent } : {}) };
      activities.set(r.turn, new ActivitySteps());
    } else if (r.type === "turn.end" || r.type === "run.end") {
      if (view.turns[r.turn]) { view.turns[r.turn].ended = r.ts; view.turns[r.turn].outcome = r.reason || r.outcome; }
    } else if (r.type === "clock.list") view.timers = r.timers;
    else if (r.type === "run.step" && view.turns[r.turn]) {
      const steps = view.turns[r.turn].steps;
      const pending = r.state === "started" ? null : [...steps].reverse().find((step) => step.step === r.step && step.state === "pending");
      if (pending) pending.state = r.state;
      else steps.push({ seq: r.seq, ts: r.ts, label: r.step, step: r.step, state: r.state === "started" ? "pending" : r.state });
    }
    else if (r.type === "activity.summary" && view.turns[r.turn]) view.turns[r.turn].steps.push({ ts: r.ts, label: r.text, summary: true, state: "note" });
    else if (r.type === "activity.request" && view.turns[r.turn]) activities.get(r.turn)?.request(r.id, r.ts, r.action);
    else if (r.type === "activity.response") {
      for (const activity of activities.values()) activity.response(r.reply_to, r.ts,
        r.result.state === "accepted" ? { status: "accepted", request_id: r.result.receipt } : r.result.state === "unconfirmed" ? { truncated: true } : { ok: r.result.state !== "failed" });
    }
    else if (r.type === "post.changed") view.held = r.held;
    else if (r.type === "self.changed") view.self.changed.push({ path: r.path, by: r.by, ts: r.ts, summary: r.summary, version: r.version });
    else if (r.type.startsWith("gate.")) for (const activity of activities.values()) activity.gate(r.requestId,
      r.type === "gate.asked" ? "等待确认" : r.type === "gate.passed" ? "已获准" : "未获准");
  }
  for (const [id, activity] of activities) view.turns[id].steps = [...view.turns[id].steps, ...activity.visible()].sort((a, b) => a.ts - b.ts);
  return view;
}

/** Folds one ledger Message. Unnumbered SSE control frames and unknown words are ignored. */
export function fold(state, message) {
  const current = state && Array.isArray(state._records) ? state : initialView();
  const next = record(message);
  if (!next || current._records.some((r) => r.id === next.id || r.seq === next.seq)) return current;
  const records = [...current._records, next].sort((a, b) => a.seq - b.seq);
  return project(records, current._postSnapshots);
}

/** Apply an authenticated, bounded control snapshot without treating it as a ledger row. */
export function foldPostSnapshot(state, snapshot) {
  const current = state && Array.isArray(state._records) ? state : initialView();
  if (postDeliverySnapshotErrors(snapshot).length) return current;
  const snapshots = new Map(current._postSnapshots);
  for (const item of snapshot.items) {
    const old = snapshots.get(item.message_id);
    if ((!old || old.state !== "dropped") && (!old || old.version_seq < item.version_seq)) snapshots.set(item.message_id, { state: item.state, version_seq: item.version_seq });
  }
  return project(current._records, snapshots);
}

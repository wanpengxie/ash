// Render selected conversation facts; gate originals appear only in an explicit plain-text disclosure.
import { cardHead, fileRef, renderCard } from "./cards.js";
import { appendApprovalOriginal, appendFullAnswer } from "./approval-original.js";
import { appendMarkdown } from "./markdown.js";
import { addIcon, avatarUrl, button, dayStamp, letterClasses, letterOf, text, validUntil } from "./chat-ui.js";
export { fileRef } from "./cards.js";

const say = (item) => item?.type === "say";
const grouped = (item, neighbor) => say(item) && say(neighbor) && item.side === "agent" && neighbor.side === "agent" && !!item.group && item.group === neighbor.group;
const deliveryText = { sent: "发送中", delivered: "已送达", read: "已读" };
/** A pause this long between two messages gets its own time line. */
const TIME_GAP = 3_600_000;

function attachment(parent, item, openInline, onOpenFile, lifetime) {
  const name = typeof item?.name === "string" ? item.name : "附件";
  const file = (label) => {
    const chip = button(parent, "", "attachment att-file");
    const tile = text(chip, "span", "", "ic");
    addIcon(tile, /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(label) ? "image" : "file");
    text(chip, "span", label, "attachment-name");
    return chip;
  };
  if (item?.source === "inline" && Number.isSafeInteger(item.index) && item.index >= 0) {
    const chip = file(name);
    chip.addEventListener("click", async () => {
      chip.disabled = true;
      chip.title = "正在读取附件";
      try {
        const opened = await openInline?.(item.message_id, item.index);
        if (!opened) throw new Error("attachment unavailable");
        if (lifetime?.disposed) { opened.revoke(); return; }
        const later = (ms) => { const timer = setTimeout(opened.revoke, ms); lifetime?.cleanup.add(() => { clearTimeout(timer); opened.revoke(); }); };
        if (opened.preview) {
          const image = document.createElement("img");
          image.alt = opened.name;
          image.src = opened.url;
          image.addEventListener("load", opened.revoke, { once: true });
          image.addEventListener("error", opened.revoke, { once: true });
          later(60_000);
          parent.append(image);
        } else {
          const download = document.createElement("a");
          download.href = opened.url;
          download.download = opened.name;
          download.click();
          later(1000);
        }
        chip.dataset.opened = "true";
        chip.title = "";
      } catch { chip.title = "附件无法打开"; }
      finally { chip.disabled = false; }
    });
    return;
  }
  if (!fileRef(item)) return;
  const chip = file(name);
  chip.disabled = typeof onOpenFile !== "function";
  chip.addEventListener("click", () => onOpenFile?.(item));
}

/** The skeleton of a conversation that has not arrived: bubbles of the right shapes, no words. */
function skeleton(fragment) {
  for (const shape of ["her-s", "her-l", "me-s", "her-m", "me-m"]) text(fragment, "div", "", `sk sk-${shape}`);
}

/** The conversation is empty and ready: who she is and what to say first. */
function emptyState(fragment) {
  const root = text(fragment, "div", "", "empty");
  const face = text(root, "span", "", "av av-120");
  const image = document.createElement("img");
  image.src = avatarUrl("default");
  image.alt = "";
  face.append(image);
  text(root, "span", "有事就跟我说", "tx-title");
  text(root, "span", "像发微信一样就行，比如：", "tx-callout");
  const examples = text(root, "div", "", "empty-examples");
  for (const line of ["「明早 8 点提醒我带伞」", "「我今天下午有什么安排？」", "「帮我查一下最近的加油站」"]) text(examples, "span", line);
}

/** The top of a conversation she started: her face and when she arrived. */
function introduction(fragment, herName) {
  const root = text(fragment, "div", "", "intro");
  const face = text(root, "span", "", "av av-88 av-breath");
  const image = document.createElement("img");
  image.src = avatarUrl("success");
  image.alt = "";
  face.append(image);
  text(root, "span", herName, "tx-headline");
  text(root, "span", "刚刚住进你的手机", "tx-caption");
}

function approvalCard(fragment, item, { onAnswerAsk, askIntents, agentName, primary, herName, onReadOriginal, onReadAnswer, lifetime }) {
  const ask = item.ask;
  const confirm = ask.from === "service:gate" || ask.human_kind === "confirmation";
  const card = text(fragment, "div", "", "a-card card ask");
  card.dataset.askId = ask.id ?? "";
  const expired = ask.state === "expired" || ask.state === "pending" && ask.expires_at <= Date.now();
  const decided = expired || ask.state !== "pending";
  const asker = ask.from?.startsWith("agent:") && ask.from !== primary ? agentName(ask.from) : herName;
  const head = confirm ? cardHead(card, "warn", "shield", "需要你确认") : cardHead(card, "her", "ask", `${asker} 问你`);
  if (!decided && Number.isFinite(ask.expires_at)) text(head, "span", validUntil(ask.expires_at), "exp ask-expiry");
  text(card, "div", ask.title, "card-title ask-title");
  // A decided card is folded to its head, its title and one result line (HANDOFF §3): no detail and no original text.
  if (!decided) {
    // The gate puts its own review on the first line of the detail ("审核：…"): it gets a note of its own under the sentence.
    const lines = String(ask.detail ?? "").split("\n");
    const review = lines[0]?.startsWith("审核：") ? lines.shift() : "";
    const detail = review ? lines.join("\n") : String(ask.detail ?? "");
    if (detail) text(card, "small", detail, "card-body ask-detail");
    if (review) text(card, "div", review, "card-note");
    appendApprovalOriginal(card, ask, "查看完整原文", { onReadOriginal, lifetime });
  }
  const chosen = (ask.options || []).find((option) => option.id === ask.choice);
  const answer = askIntents?.get(ask.id);
  // A decided card says how it ended instead of keeping buttons that look live but do nothing.
  if (decided) {
    if (!confirm && chosen && !expired) {
      const choices = text(card, "div", "", "opts");
      for (const option of ask.options) {
        const mine = option.id === ask.choice;
        button(choices, option.label, `opt ${mine ? "on" : "dim"}`, mine ? "check" : "", "i-xs").disabled = true;
      }
      return;
    }
    const outcome = expired ? "已过期，未执行" :
      ask.choice === "deny" ? "已拒绝" : ask.choice === "once" ? "已允许这一次" : chosen ? `已选择：${chosen.label}` : ask.answer_text ? `已回答：${ask.answer_text}` : "已结束";
    const ok = !expired && (ask.choice === "once" || ask.choice === "always");
    const fullAnswer = !expired && appendFullAnswer(card, ask, { onReadAnswer, lifetime, label: outcome });
    if (fullAnswer) { fullAnswer.children[0].className = "resolved ask-outcome"; return; }
    const line = text(card, "div", "", `resolved ask-outcome${ok ? " ok" : ""}`);
    if (ok) addIcon(line, "check", "i-xs");
    text(line, "span", outcome);
    return;
  }
  const locked = (option) => answer?.status === "pending" || answer?.status === "confirmed" || answer?.status === "rejected" || Boolean(answer?.choice && answer.choice !== option.id);
  const press = (control, option) => {
    control.disabled = typeof onAnswerAsk !== "function" || locked(option);
    control.addEventListener("click", async () => {
      if (control.disabled) return;
      control.disabled = true;
      try { await onAnswerAsk(ask, option.id); }
      catch { control.disabled = false; }
    });
  };
  const options = ask.options || [];
  let actions;
  if (confirm) {
    // The first choice is the main one; the others sit side by side under it.
    actions = text(card, "div", "", "card-acts ask-actions");
    let two = null;
    options.forEach((option, index) => {
      if (index === 0) { press(button(actions, option.label, "a-btn btn-primary btn-block"), option); return; }
      two ??= text(actions, "div", "", "two");
      press(button(two, option.label, `a-btn ${index === 1 && options.length > 2 ? "btn-secondary" : "btn-neutral"}`), option);
    });
  } else {
    actions = text(card, "div", "", "opts ask-actions");
    for (const option of options) press(button(actions, option.label, "opt"), option);
  }
  if (ask.allow_custom && typeof onAnswerAsk === "function") {
    const row = text(card, "div", "", "say");
    const input = document.createElement("input");
    input.placeholder = "自己说…";
    input.className = "card-custom";
    input.maxLength = 4000;
    input.value = answer?.customDraft ?? "";
    input.disabled = Boolean(answer?.choice);
    input.addEventListener("input", () => { if (askIntents && !askIntents.get(ask.id)?.choice)
      askIntents.set(ask.id, { customDraft: input.value }); });
    row.append(input);
    const send = button(row, "", "sbtn", "up", "i-s");
    send.setAttribute("aria-label", "发送回答");
    send.disabled = Boolean(answer?.status === "pending" || answer?.status === "confirmed");
    const submit = async () => { if (!input.value.trim() || send.disabled) return; send.disabled = true;
      try { await onAnswerAsk(ask, "custom", input.value.trim()); } finally { send.disabled = false; } };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submit(); } });
  }
  if (answer?.status === "uncertain") text(card, "small", "还没收到确认，请再点一次刚才的选项。", "card-note");
}

/** A turn that ended badly: one card, and one button to try again. */
function failureCard(fragment, failure, { onRetry }) {
  const card = text(fragment, "div", "", "a-card card failure");
  card.dataset.turn = failure.turn;
  cardHead(card, "err", "alert", "没做成");
  text(card, "div", "刚才这件事没做成，可能是网络不稳，或是模型那边出了问题。", "card-body card-body-text");
  if (failure.retry && typeof onRetry === "function") {
    const row = text(card, "div", "", "card-row");
    const retry = button(row, "重试", "a-btn btn-sm btn-primary", "refresh", "i-xs");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try { await onRetry(failure); } catch { retry.disabled = false; }
    });
  }
}

/** Append a stable ledger conversation without inventing an approval or option action. */
export function appendConversation(fragment, entries, { openInline, onOpenFile, onFileLink, onExpand, fullTexts, onSelect, onAnswerAsk, onPermission, onRetry, optionPending, askIntents, onReadOriginal, onReadAnswer, a2ui = null, agentName = id => id.replace(/^agent:/, ""), primary = null, loading = false, herName = "Ash", failures = [], atStart = false, intro, now = Date.now(), previous: previousEntry = null, next: nextEntry = null, previousDisplay = null, omitContent = false, lifetime, renderMarkdown = appendMarkdown } = {}) {

  if (!entries.length && !failures.length) { if (loading) skeleton(fragment); else emptyState(fragment); return; }
  // Only before the owner has said anything: it is the first meeting, and she spoke first.
  if (intro ?? (atStart && entries.length <= 8 && entries[0]?.side === "agent" && !entries.some((item) => item.side === "owner"))) introduction(fragment, herName);
  const pendingFailures = [...failures].sort((a, b) => a.ts - b.ts);
  let lastTs = previousDisplay?.ts ?? null;
  let lastSide = previousDisplay?.side ?? null;
  const flushFailures = (before) => {
    while (pendingFailures.length && (before === undefined || pendingFailures[0].ts <= before)) { failureCard(fragment, pendingFailures.shift(), { onRetry }); lastSide = null; }
  };
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index];
    flushFailures(item.ts ?? Infinity);
    if (item.type === "failed") { failureCard(fragment, item, { onRetry }); lastSide = null; continue; }
    if (Number.isFinite(item.ts) && (lastTs === null || item.ts - lastTs >= TIME_GAP || new Date(item.ts).toDateString() !== new Date(lastTs).toDateString())) {
      text(fragment, "span", dayStamp(item.ts, now), "daysep");
      lastSide = null;
    }
    if (Number.isFinite(item.ts)) lastTs = item.ts;
    if (item.type === "say") {
      const side = item.side === "owner" ? "me" : "ai";
      const previous = grouped(item, entries[index - 1] ?? previousEntry);
      const runStart = side === "me" ? lastSide !== "me" : !previous;
      lastSide = side;
      if (item.side === "owner" && item.origin?.label) text(fragment, "small", `来自 ${item.origin.label}`, "from r");
      if (item.side === "agent" && item.from?.startsWith("agent:") && item.from !== primary && !previous) {
        const byline = text(fragment, "div", "", "byline agent-byline");
        text(byline, "span", letterOf(agentName(item.from)), `${letterClasses(agentName(item.from))} agent-avatar`);
        text(byline, "span", `${agentName(item.from)}${primary ? ` · ${agentName(primary)} 的帮手` : ""}`);
      }
      if (item.side === "owner" && item.to && item.to !== primary) text(fragment, "small", `@ ${agentName(item.to)}`, "from r");
      const continues = grouped(item, entries[index + 1] ?? nextEntry);
      const group = item.side === "agent" && item.group ? ` group-${previous ? continues ? "middle" : "last" : continues ? "first" : "single"}` : "";
      const rich = item.side === "agent";
      const shown = item.full && fullTexts?.has(item.full, item.id) ? fullTexts.get(item.full) : item.text;
      const look = side === "me" ? "b b-me" : `b b-her md${previous ? " mid" : ""}`;
      // Attachments stand above the words, as their own blocks; a message of attachments alone has no bubble.
      const attached = Array.isArray(item.attachments) && item.attachments.length > 0;
      if (attached) {
        const attachments = text(fragment, "div", "", `atts ${side}${runStart ? " run-start" : ""}`);
        attachments.dataset.seq = String(item.seq);
        if (!omitContent) for (const ref of item.attachments) attachment(attachments, ref, openInline, onOpenFile, lifetime);
      }
      if (attached && !String(shown ?? "").trim() && !item.full) {
        if (item.side === "owner") text(fragment, "span", deliveryText[item.delivery] || deliveryText.sent, "delivery meta r");
        continue;
      }
      const bubble = text(fragment, "div", rich ? "" : shown, `msg ${side} ${look}${runStart && !attached ? " run-start" : ""}${group}`);
      if (rich && !omitContent) renderMarkdown(bubble, shown, { onFileLink }, item, lifetime);
      bubble.dataset.seq = String(item.seq);
      if (!omitContent && item.full && !fullTexts?.has(item.full, item.id) && onExpand) {
        // The ledger holds only the start and the end of a long text; the page reads the rest on demand and draws again.
        const more = text(bubble, "button", fullTexts?.expansionLabel?.(item.id) ?? "显示全文", "expand");
        more.type = "button";
        more.addEventListener("click", async () => {
          more.disabled = true; more.textContent = "正在展开…";
          // This button initiates a deliberate body replacement; its focus must not defer that replacement forever.
          more.blur?.();

          try { await onExpand(item.full, item.id); } catch { more.disabled = false; more.textContent = "显示全文"; more.title = "全文暂时读不到"; }
        });
      }
      if (Array.isArray(item.reactions) && item.reactions.length) {
        const reactions = text(bubble, "span", "", "reactions");
        for (const reaction of item.reactions) if (typeof reaction?.emoji === "string" && reaction.emoji) {
          const count = Number.isSafeInteger(reaction.count) && reaction.count > 1 ? ` ${reaction.count}` : "";
          text(reactions, "span", `${reaction.emoji}${count}`, "reaction");
        }
      }
      if (item.side === "owner") text(fragment, "span", deliveryText[item.delivery] || deliveryText.sent, "delivery meta r");
    } else if (item.type === "ask") {
      lastSide = "card";
      approvalCard(fragment, item, { onAnswerAsk, askIntents, agentName, primary, herName, onReadOriginal, onReadAnswer, lifetime });
    } else if (item.type === "card") {
      lastSide = "card";
      renderCard(fragment, item, { onSelect, onPermission, optionPending, onOpenFile, herName, a2ui });
    }
  }
  flushFailures();
}

/** Local-only placeholders are removed as soon as their accepted id appears in the ledger. */
export function appendOutbox(fragment, outbox) {
  const labels = { unsent: "等连上就发", sending: "发送中…", accepted: "已送达", rejected: "没发出去" };
  for (const item of outbox || []) {
    if (!item || typeof item.client_id !== "string" || typeof item.text !== "string" || !Object.hasOwn(labels, item.status)) continue;
    const waiting = item.status === "unsent" || item.status === "sending";
    const bubble = text(fragment, "div", item.text, `msg me b b-me pending-local${waiting ? " waiting" : ""}`);
    bubble.dataset.clientId = item.client_id;
    for (const file of item.attachments || []) if (typeof file?.name === "string") text(bubble, "div", `${file.name} · ${Math.ceil((file.size || 0) / 1024)} KiB`, "attachment");
    const meta = text(fragment, "span", "", `meta-pending r${item.status === "rejected" ? " error c-err" : ""}`);
    addIcon(meta, item.status === "rejected" ? "alert" : "clock", "i-xs");
    text(meta, "span", labels[item.status]);
  }
}

/** Ordered entities retain the existing sibling layout; neighbors need no body text. */
export function conversationRows(entries, { failures = [], atStart = false, intro, previous = null, next = null, previousDisplay = null } = {}) {
  const rows = [];
  if (!entries.length && !failures.length) return [{ key: "state", kind: "state" }];
  if (intro ?? (atStart && entries.length <= 8 && entries[0]?.side === "agent" && !entries.some(item => item.side === "owner"))) rows.push({ key: "intro", kind: "intro" });
  const pending = [...failures].sort((a, b) => a.ts - b.ts);
  let ts = previousDisplay?.ts ?? previous?.ts ?? null, side = previous?.side === "owner" ? "me" : previous?.type === "say" ? "ai" : null;
  const flush = before => { while (pending.length && pending[0].ts <= before) { const item = pending.shift(); rows.push({ key: `failure:${item.turn}`, kind: "failure", item }); side = null; } };
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index]; flush(item.ts ?? Infinity);
    if (item.type === "failed") { rows.push({ key: `failure:${item.id ?? item.turn}`, kind: "failure", item }); side = null; continue; }
    rows.push({ key: `message:${item.id ?? item.ask?.id ?? item.seq}`, kind: "message", item,
      previous: entries[index - 1] ?? previous, next: entries[index + 1] ?? next, previousDisplay: { ts, side } });
    if (Number.isFinite(item.ts)) { if (ts === null || item.ts - ts >= TIME_GAP || new Date(item.ts).toDateString() !== new Date(ts).toDateString()) side = null; ts = item.ts; }
    side = item.type === "say" ? item.side === "owner" ? "me" : "ai" : "card";
  }
  flush(Infinity); return rows;
}

/** Render just one entity with the time/group context supplied by its range. */
export function appendConversationRow(parent, row, options = {}) {
  if (row.kind === "intro") introduction(parent, options.herName ?? "Ash");
  else if (row.kind === "failure") failureCard(parent, row.item, options);
  else if (row.kind === "state") { if (options.loading) skeleton(parent); else emptyState(parent); }
  else if (row.kind === "outbox") appendOutbox(parent, [row.item]);
  else appendConversation(parent, [row.item], { ...options, atStart: false, intro: false, failures: [], previous: row.previous, next: row.next, previousDisplay: row.previousDisplay });
}

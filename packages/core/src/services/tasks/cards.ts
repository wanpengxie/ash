// What service:tasks shows in the conversation, and the small time rules it keeps. Pure: no state, no I/O.
//
// A task has at most a few cards in the conversation, each one of three kinds:
//   noted    「记下了：…」 when an agent wrote it down (the owner can change it there: content and reminder)
//   remind   「提醒：…」 at its remind_at: 完成 / 一小时后再提醒
//   follow   「…到期了，还没完成」 once after its due_at: 完成 / 改期 / 不做了
// Their buttons call service:tasks itself (service:cards/act): the owner's press is the owner's change, as in the 任务 app.
// When the task changes the cards are drawn again from it; when it is closed they show how it ended and stop.
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import { WordError } from "../../../../sdk/src/message";
/** Next local morning, also used for the small reschedule form. */
function nextMoment(from: number, time: string): number {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(from);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return at > from ? at : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
}

export const TASKS_ID = "service:tasks";
export type CardKind = "noted" | "remind" | "follow";
const OPEN = new Set(["todo", "doing", "waiting"]);

export interface Task {
  id: string; title: string; note: string; subject: "owner" | "ash"; assignee: string; status: string;
  due_at: number | null; remind_at: number | null; source: { message?: string; turn?: string; agent?: string } | null;
  thread: string | null; result: string | null; created_by: string; created_at: number; updated_by: string; updated_at: number; done_at: number | null;
}

export const isOpen = (task: Pick<Task, "status">): boolean => OPEN.has(task.status);

/** A follow-up of the owner's task comes the morning after it fell due (at least an hour later), never at night; an agent's at the time itself. */
export const FOLLOW_UP_TIME = "09:00";
export function followUpAt(task: Pick<Task, "assignee" | "due_at">): number | null {
  if (task.due_at === null) return null;
  return isAgentId(task.assignee) ? task.due_at : nextMoment(task.due_at + 3_600_000 - 1, FOLLOW_UP_TIME);
}

/**
 * A time as a word gives it: Unix ms, or ISO text (`2026-10-16T20:00`, read in the hub's local time when it has no zone;
 * `2026-10-16` alone is the end of that day). undefined: not given; null (or empty text): cleared.
 */
export function parseTime(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new WordError("bad_request", `${field}: invalid Unix ms`);
    return value;
  }
  const text = String(value).trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59, 999).getTime() : Date.parse(text);
  if (!Number.isFinite(at) || at < 0 || (day && new Date(at).getMonth() !== Number(day[2]) - 1)) throw new WordError("bad_request", `${field}: "${text}" is not a time`, { recovery_hint: "Give Unix ms, or ISO text like 2026-10-16T20:00 (local time) or 2026-10-16." });
  return at;
}

/** The input value of a DateTimeInput for [at] (local, minutes), or "" for none. */
export function isoLocal(at: number | null): string {
  if (at === null) return "";
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dayStart = (at: number) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** 「今天 20:00」「明天」「周五 09:30」「10月20日」: a day near [now] by name, a time unless it is the end of the day. */
export function when(at: number, now: number): string {
  const d = new Date(at);
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const day = days === 0 ? "今天" : days === 1 ? "明天" : days === 2 ? "后天" : days === -1 ? "昨天"
    : days > 2 && days < 7 ? WEEK[d.getDay()]! : `${d.getMonth() + 1}月${d.getDate()}日`;
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
  return endOfDay ? day : `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Who did it, as the conversation says it. */
export function who(member: string, primary: string | null): string {
  if (member === OWNER_ID) return "你";
  if (member === primary) return "Ash";
  if (member === TASKS_ID) return "Ash";
  return member.replace(/^[a-z]+:/, "");
}

/** The one line under the title: its times and, when it is not the obvious one, who does it. */
export function timeLine(task: Task, now: number, primary: string | null): string {
  const parts: string[] = [];
  if (task.remind_at !== null) parts.push(`提醒 ${when(task.remind_at, now)}`);
  if (task.due_at !== null) parts.push(`${when(task.due_at, now)}前`);
  const obvious = task.subject === "owner" ? task.assignee === OWNER_ID : task.assignee === primary;
  if (!obvious) parts.push(`${who(task.assignee, primary)}来做`);
  if (task.status === "waiting") parts.push("在等对方");
  return parts.join(" · ");
}

/** The conversation card of [task] as a card of [kind], drawn from the task as it is at [now]. */
export function cardOf(task: Task, kind: CardKind, now: number, primary: string | null): { a2ui: Record<string, unknown>; text: string } {
  const line = timeLine(task, now, primary);
  const mine = task.subject === "ash";
  const call = (word: string, body: Record<string, unknown>) => ({ call: { member: TASKS_ID, word, body: { id: task.id, ...body } } });
  const components: Record<string, unknown>[] = [];
  const text = (id: string, value: unknown, extra: Record<string, unknown> = {}) => components.push({ id, component: "Text", text: value, ...extra });
  const button = (id: string, label: string, action: unknown, variant = "default") => {
    components.push({ id, component: "Button", child: `${id}.t`, variant, action });
    text(`${id}.t`, label);
  };
  const children: string[] = [];

  if (!isOpen(task)) {
    const done = task.status === "done";
    const title = `${done ? "做完了" : "不做了"}：${task.title}`;
    const by = `${who(task.updated_by, primary)} · ${when(task.done_at ?? task.updated_at, now)}`;
    text("title", `**${title}**`, { style: done ? {} : { strikethrough: true } });
    children.push("title");
    if (task.result) { text("result", task.result); children.push("result"); }
    text("by", by, { variant: "caption" });
    children.push("by");
    components.unshift({ id: "root", component: "Column", gap: 6, children });
    return { a2ui: { components }, text: `${title}${task.result ? `：${task.result}` : ""}` };
  }

  const head = kind === "remind" ? `提醒：${task.title}` : kind === "follow" ? `「${task.title}」到期了，还没完成` : `${mine ? "我来做" : "记下了"}：${task.title}`;
  text("title", `**${head}**`);
  children.push("title");
  if (line) { text("when", line, { variant: "caption" }); children.push("when"); }
  if (task.note && kind === "noted") { text("note", task.note); children.push("note"); }
  const data: Record<string, unknown> = {};
  const row: string[] = [];
  if (kind === "noted") {
    // Changing it on the spot: the fields show when 修改 is ticked (on the phone itself), and 保存 writes them.
    data.title = task.title; data.remind = isoLocal(task.remind_at); data.editing = false;
    components.push({ id: "edit", component: "CheckBox", label: "修改", value: { path: "/editing" } });
    components.push({ id: "form", component: "Column", gap: 8, visible: { path: "/editing" }, children: ["f.title", "f.remind", "f.save"] });
    components.push({ id: "f.title", component: "TextField", label: "内容", value: { path: "/title" }, variant: "shortText" });
    components.push({ id: "f.remind", component: "DateTimeInput", label: "提醒时间", value: { path: "/remind" }, enableDate: true, enableTime: true });
    button("f.save", "保存", call("update", { title: { path: "/title" }, remind_at: { path: "/remind" } }), "primary");
    button("drop", mine ? "不用做了" : "不用记", call("update", { status: "dropped" }), "borderless");
    row.push("edit", "drop");
    children.push("row", "form");
  } else if (kind === "remind") {
    button("done", "完成", call("done", {}), "primary");
    button("later", "一小时后再提醒", call("update", { remind_in: 60 }));
    row.push("done", "later");
    children.push("row");
  } else {
    data.due = isoLocal(nextMoment(now, FOLLOW_UP_TIME));
    components.push({ id: "f.due", component: "DateTimeInput", label: "改到", value: { path: "/due" }, enableDate: true, enableTime: true });
    button("done", "完成", call("done", {}), "primary");
    button("move", "改期", call("update", { due_at: { path: "/due" }, remind_at: { path: "/due" } }));
    button("drop", "不做了", call("update", { status: "dropped" }), "borderless");
    row.push("done", "move", "drop");
    children.push("f.due", "row");
  }
  components.push({ id: "row", component: "Row", gap: 8, align: "center", children: row });
  components.unshift({ id: "root", component: "Column", gap: 8, children });
  return { a2ui: { components, data }, text: [head, line].filter(Boolean).join(" · ") };
}

/** A card's name in the conversation: `task.<id>.<kind>.<stamp>` (the kind is read back from it). */
export const cardId = (task: string, kind: CardKind, at: number): string => `task.${task}.${kind}.${at.toString(36)}`;
export const kindOfCard = (id: string): CardKind => (id.split(".")[2] as CardKind) ?? "noted";

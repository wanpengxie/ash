/**
 * `person:owner/form`: a card with inputs in the conversation that waits for the owner to send it (docs/GENUI.md §6). The
 * card is written here from the JSON Schema the agent gave and kept with the other cards; the request stays open, like
 * `ask`, until the owner sends or cancels it on any channel (a `send` of kind `response`, word `form`) or it ends.
 *
 * A field named in `secret` is a password box. The owner's screen saves what is typed there with `service:vault/set`
 * before it answers; the answer carries only `{ref, masked}`, and the hub checks the vault holds every ref by then.
 */
import { errorBody, WordError, type Message, type WordResult } from "../../../../../sdk/src/message";
import type { AnswerResult } from "./ask";
import { DEFAULT_EXPIRY_MS, MAX_EXPIRY_MS } from "./ask";
import type { Cards, FormInfo } from "./cards";

type Field = { type: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; examples?: unknown[]; format?: string };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Component ids are letters, digits and _ . -; a field name may be anything. */
const slug = (name: string, i: number) => `f${i}_${name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`;
const pathOf = (name: string) => `/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** The card of a form: a title, why, one input per field, and 「取消」 / 「提交」. */
export function formCard(body: { title: string; why?: string; schema: { properties: Record<string, Field>; required?: string[] }; values?: Record<string, unknown>; secret?: Record<string, string> }):
  { a2ui: Record<string, unknown>; info: Omit<FormInfo, "request" | "expires_at"> } {
  const secret = body.secret ?? {};
  const required = (body.schema.required ?? []).filter((name) => Object.hasOwn(body.schema.properties, name));
  for (const name of Object.keys(secret)) if (!Object.hasOwn(body.schema.properties, name)) throw new WordError("bad_request", `secret names ${name}, which is not a field of the schema`);
  const components: Record<string, unknown>[] = [];
  const data: Record<string, unknown> = {};
  const fields: FormInfo["fields"] = {};
  // Spacing: 12 between the blocks (the head, each field, the buttons), 2 inside the head, 4 between a field and its note.
  const children = ["head"];
  const head = ["title"];
  components.push({ id: "title", component: "Text", text: body.title, variant: "h4" });
  if (body.why?.trim()) { components.push({ id: "why", component: "Text", text: body.why, variant: "caption" }); head.push("why"); }
  components.push({ id: "head", component: "Column", gap: 2, children: head });
  Object.entries(body.schema.properties).forEach(([name, f], i) => {
    const id = slug(name, i), path = pathOf(name);
    const label = (f.title?.trim() || name) + (required.includes(name) ? "" : "（选填）");
    fields[name] = { type: f.type, title: f.title?.trim() || name, ...(Array.isArray(f.enum) ? { enum: f.enum } : {}) };
    const given = body.values?.[name] ?? f.default;
    const hint = Array.isArray(f.examples) && f.examples.length ? String(f.examples[0]) : undefined;
    if (secret[name]) {
      components.push({ id, component: "TextField", label, variant: "obscured", value: { path }, ...(hint ? { placeholder: hint } : {}) });
    } else if (Array.isArray(f.enum)) {
      components.push({ id, component: "ChoicePicker", label, options: f.enum.map((v) => ({ label: String(v), value: String(v) })), value: { path }, displayStyle: "chips" });
      data[name] = given === undefined ? [] : [String(given)];
    } else if (f.type === "boolean") {
      components.push({ id, component: "Switch", label, value: { path } });
      data[name] = given === true;
    } else if (f.format === "date" || f.format === "time" || f.format === "date-time") {
      components.push({ id, component: "DateTimeInput", label, value: { path }, enableDate: f.format !== "time", enableTime: f.format !== "date" });
      data[name] = given === undefined ? "" : String(given);
    } else {
      const variant = f.type === "number" || f.type === "integer" ? "number" : f.format === "multiline" ? "longText" : "shortText";
      components.push({ id, component: "TextField", label, variant, value: { path }, ...(hint ? { placeholder: hint } : {}) });
      data[name] = given === undefined ? "" : String(given);
    }
    if (f.description?.trim()) {
      components.push({ id: `${id}.about`, component: "Text", text: f.description, variant: "caption" }, { id: `${id}.group`, component: "Column", gap: 4, children: [id, `${id}.about`] });
      children.push(`${id}.group`);
    } else children.push(id);
  });
  // 「提交」 is off until every required field that is not a password has something (a password box is checked on the phone).
  const checks = required.filter((name) => !secret[name]).map((name) => ({ condition: { call: "required", args: { value: { path: pathOf(name) } } }, message: `${fields[name]!.title}还没填` }));
  components.push(
    { id: "actions", component: "Row", justify: "end", gap: 8, children: ["cancel", "submit"] },
    { id: "cancel", component: "Button", variant: "borderless", child: "cancel.label", action: { event: { name: "cancel" } } },
    { id: "cancel.label", component: "Text", text: "取消" },
    { id: "submit", component: "Button", variant: "primary", child: "submit.label", action: { event: { name: "submit" } }, ...(checks.length ? { checks } : {}) },
    { id: "submit.label", component: "Text", text: "提交" },
  );
  children.push("actions");
  components.unshift({ id: "root", component: "Column", gap: 12, children });
  return { a2ui: { components, data }, info: { fields, required, secret } };
}

interface Entry { id: string; settle(result: WordResult | WordError): void; timer: ReturnType<typeof setTimeout> }

export class Forms {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly o: { now(): number; cards: Cards; vaultHas(ref: string): boolean; changed(): void }) {}

  has(id: string): boolean { return this.entries.has(id); }
  list(): string[] { return [...this.entries.keys()]; }

  /** Opens the form of [msg] (its card is already kept under the message id); settles when it is sent, cancelled or ends. */
  wait(msg: Message, signal: AbortSignal): Promise<WordResult> {
    const body = (msg.body ?? {}) as { expires_at?: unknown };
    const expires = Math.min(typeof body.expires_at === "number" ? body.expires_at : msg.ts + DEFAULT_EXPIRY_MS, msg.ts + MAX_EXPIRY_MS);
    return new Promise<WordResult>((resolve, reject) => {
      const entry: Entry = {
        id: msg.id,
        settle: (result) => {
          clearTimeout(entry.timer);
          if (this.entries.get(msg.id) !== entry) return;
          this.entries.delete(msg.id);
          this.o.changed();
          if (result instanceof WordError) reject(result); else resolve(result);
        },
        timer: setTimeout(() => { this.o.cards.setState(msg.id, "expired"); entry.settle(new WordError("timeout", "the owner did not fill in the form before it ended")); }, Math.max(0, expires - this.o.now())),
      };
      entry.timer.unref?.();
      this.entries.set(msg.id, entry);
      const withdraw = () => { this.o.cards.setState(msg.id, "closed"); entry.settle(new WordError("cancelled", "the form was withdrawn")); };
      signal.addEventListener("abort", withdraw, { once: true });
      if (signal.aborted) withdraw(); else this.o.changed();
    });
  }

  /**
   * The owner's answer: `{ok: true, result: {data: {values, secret}}}` (sent) or `{ok: false, error: {code: "cancelled"}}`.
   * The values are taken as the fields say (a choice is one value, a number a number); every secret ref must be in the vault.
   */
  answer(id: string, body: unknown): AnswerResult {
    const entry = this.entries.get(id);
    const row = this.o.cards.get(id);
    if (!entry || !row?.form) return { ok: false, error: errorBody("conflict", "this form is no longer open") };
    const b = body as { ok?: unknown; error?: { code?: unknown }; result?: { data?: { values?: unknown; secret?: unknown } } } | null;
    if (b?.ok === false && b.error?.code === "cancelled") {
      this.o.cards.setState(id, "cancelled");
      entry.settle(new WordError("cancelled", "the owner declined to fill in the form", { recovery_hint: "Do not send the same form again at once. Ask the owner in words what is wrong, or find a way without it." }));
      return { ok: true };
    }
    const data = b?.ok === true ? b.result?.data : undefined;
    if (!plain(data) || !plain(data.values) || (data.secret !== undefined && !plain(data.secret)))
      return { ok: false, error: errorBody("bad_request", "an answer is {ok: true, result: {data: {values, secret}}} or {ok: false, error: {code: \"cancelled\"}}") };
    const form = row.form;
    const values: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(data.values as Record<string, unknown>)) {
      const field = form.fields[name];
      if (!field || form.secret[name]) continue;
      const one = Array.isArray(raw) ? raw[0] : raw;
      if (one === undefined || one === null || one === "") continue;
      if (field.type === "number" || field.type === "integer") {
        const n = Number(one);
        if (!Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n))) return { ok: false, error: errorBody("bad_request", `${field.title} must be a ${field.type === "integer" ? "whole number" : "number"}`) };
        values[name] = n;
      } else if (field.type === "boolean") values[name] = one === true || one === "true";
      else values[name] = String(one);
    }
    const missing = form.required.filter((name) => !form.secret[name] && values[name] === undefined);
    if (missing.length) return { ok: false, error: errorBody("bad_request", `not filled in: ${missing.map((name) => form.fields[name]!.title).join(", ")}`) };
    const given = (data.secret ?? {}) as Record<string, { ref?: unknown; masked?: unknown }>;
    const secret: Record<string, { ref: string; masked: string }> = {};
    for (const [name, ref] of Object.entries(form.secret)) {
      const s = given[name];
      if (!plain(s)) {
        if (form.required.includes(name)) return { ok: false, error: errorBody("bad_request", `${form.fields[name]!.title} was not filled in`) };
        continue;
      }
      if (s.ref !== ref) return { ok: false, error: errorBody("bad_request", `${form.fields[name]!.title} goes to the vault as ${ref}`) };
      if (!this.o.vaultHas(ref)) return { ok: false, error: errorBody("conflict", `${ref} is not in the vault yet: save it with service:vault/set first, then answer`) };
      secret[name] = { ref, masked: typeof s.masked === "string" && /^\*{4}[^*]{0,4}$/.test(s.masked) ? s.masked : "****" };
    }
    this.o.cards.setState(id, "sent", values);
    entry.settle({ data: { values, secret } });
    return { ok: true };
  }

  /** The router gave up on the request (cancelled, or its own time ran out). */
  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.o.cards.setState(id, "closed");
    entry.settle(new WordError("cancelled", "the form was withdrawn"));
  }
}

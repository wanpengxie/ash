/**
 * Notifications (SPEC-03 §5.4, surface `notification`): what rings on the owner's phone, and when. The conversation
 * itself is `sync`; this only decides whether a message also rings (rules in ./delivery) and builds the presentation the
 * channel shows. It is sent only to channels that declared the surface.
 *
 * A reply whose turn is still running is shown quietly; when the turn ends and the last reply of it was only shown
 * quietly, and the owner is still not looking, that notification is raised again strongly (`alert`).
 */
import { isAgentId } from "../../../../../sdk/src/ids";
import type { Message } from "../../../../../sdk/src/message";
import type { Clients, LiveClient } from "./clients";
import { Delivery, rings as mayRing, rulesOf, type DeliveryKind } from "./delivery";
import type { PendingAsk } from "./ask";
import type { Presenter } from "./present";

const TEXT_MAX = 500;
const clip = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text);
const TITLES: Record<string, string> = { reply: "Ash", due: "提醒", offer: "Ash", heads_up: "Ash" };

export interface NotifierDeps {
  clients: Clients;
  presenter: Presenter;
  settings(): Record<string, unknown>;
  now(): number;
  zone?: string;
  /** How long the island may take to say whether it is on screen. */
  islandMs: number;
  /** The primary agent: the one a reply on a notification goes to when the message did not come from an agent; null when there is no agent yet. */
  primary(): string | null;
}

export class Notifier {
  private readonly delivery: Delivery;
  private readonly running = new Set<string>();
  /** turn -> the reply that was shown quietly and is the turn's last so far, and the channels it was shown on. */
  private readonly quietReplies = new Map<string, { id: string; clients: string[] }>();
  /** The replies of a running turn still being shown: its end waits for them, so a reply whose channel has not answered yet still counts. */
  private readonly showing = new Map<string, Promise<void>>();

  constructor(private readonly d: NotifierDeps) { this.delivery = new Delivery(d.zone); }

  /** The owner is looking at Ash: a channel is visible, or the task island is on screen. */
  async watching(): Promise<boolean> {
    if (this.d.clients.watching()) return true;
    const islands = this.d.clients.withSurface("island");
    const answers = await Promise.all(islands.map((c) => this.d.presenter.send(c, { surface: "island", op: "query", body: {} }, this.d.islandMs)));
    return answers.some((r) => r.ok && (r.data as { showing?: unknown } | undefined)?.showing === true);
  }

  private async rings(kind: DeliveryKind, dedupe_key: string | undefined): Promise<boolean> {
    const targets = this.d.clients.withSurface("notification");
    if (!targets.length) return false;
    const verdict = this.delivery.decide({ kind, ...(dedupe_key ? { dedupe_key } : {}) }, this.d.now(), await this.watching(), rulesOf(this.d.settings()));
    return verdict === "ring";
  }

  /** Shows a notification on every channel that declared the surface; returns the channels that took it. */
  private async showTo(body: Record<string, unknown>): Promise<LiveClient[]> {
    const targets = this.d.clients.withSurface("notification");
    const results = await Promise.all(targets.map((c) => this.d.presenter.send(c, { surface: "notification", op: "show", body: body as never })));
    // A channel that says the notification is already past its time (`expired`) did not show it.
    return targets.filter((_, i) => { const r = results[i]!; return r.ok && (r.data as { expired?: unknown } | undefined)?.expired !== true; });
  }

  /** `person:owner/say`. */
  say(msg: Message): Promise<void> {
    const turn = msg.turn;
    const done = this.deliver(msg);
    if (turn) {
      const all = Promise.all([this.showing.get(turn), done.catch(() => undefined)]).then(() => undefined);
      this.showing.set(turn, all);
      void all.then(() => { if (this.showing.get(turn) === all) this.showing.delete(turn); });
    }
    return done;
  }

  private async deliver(msg: Message): Promise<void> {
    const body = msg.body as { text: string; kind?: DeliveryKind; dedupe_key?: string };
    const kind: DeliveryKind = body.kind ?? "reply";
    if (!mayRing(kind)) return;
    const turn = msg.turn;
    const quiet = kind === "reply" && turn !== undefined && this.running.has(turn);
    // A notification says who a reply goes to; with no agent at all there is nobody to reply to.
    const target = isAgentId(msg.from) ? msg.from : this.d.primary();
    if (!target || !(await this.rings(kind, body.dedupe_key))) { if (turn) this.quietReplies.delete(turn); return; }
    const reached = await this.showTo({
      id: msg.id, kind, title: TITLES[kind] ?? "Ash", text: clip(body.text), reply_to: msg.id, reply_target: target, ...(kind === "reply" ? { alert: quiet ? "quiet" : "strong" } : {}),
    });
    if (turn && kind === "reply") { if (quiet && reached.length) this.quietReplies.set(turn, { id: msg.id, clients: reached.map((c) => c.client) }); else this.quietReplies.delete(turn); }
  }

  /** `person:owner/notice`: a notification outside the conversation, that opens a page of the app. */
  async notice(msg: Message): Promise<void> {
    const body = msg.body as { title: string; text: string; open?: string; dedupe_key?: string };
    if (!(await this.rings("heads_up", body.dedupe_key))) return;
    await this.showTo({ id: msg.id, kind: "notice", title: body.title, text: clip(body.text), ...(body.open ? { open: body.open } : {}) });
  }

  /** An open question or approval card. Returns the channels that were notified (to take it down when it ends). */
  async ask(ask: PendingAsk): Promise<string[]> {
    if (!(await this.rings("ask", undefined))) return [];
    const reached = await this.showTo({
      id: ask.id, kind: "approval", title: ask.title, text: clip(ask.detail), options: ask.options, expires_at: ask.expires_at, reply_to: ask.id, reply_target: ask.from,
      ...(ask.kind === "approval" ? {} : { human_kind: "question", ...(ask.allow_custom ? { allow_custom: true } : {}) }),
    });
    return reached.map((c) => c.client);
  }

  /** Takes a notification down on the channels that were shown it (the question was answered or ended). */
  hide(id: string, clients: Iterable<string>): void {
    for (const client of clients) {
      const c = this.d.clients.get(client);
      if (c) void this.d.presenter.send(c, { surface: "notification", op: "hide", body: { id } });
    }
  }

  turnStarted(turn: string): void { this.running.add(turn); }

  async turnEnded(turn: string): Promise<void> {
    this.running.delete(turn);
    await this.showing.get(turn);
    const quiet = this.quietReplies.get(turn);
    this.quietReplies.delete(turn);
    if (!quiet || await this.watching()) return;
    const { id } = quiet;
    for (const client of quiet.clients) {
      const c = this.d.clients.get(client);
      if (c) await this.d.presenter.send(c, { surface: "notification", op: "alert", body: { id } });
    }
  }
}

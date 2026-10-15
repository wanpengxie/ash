/**
 * human (HUB-MODULES §2.2): the member `person:owner` and the owner's channels on the link. Every connection that opened
 * the `human` channel is one channel `client:<sid>`.
 *
 *   in    `send` -> `router.send` as the owner (./inbound); `presence` -> remembered; `sync` -> the ledger (./sync)
 *   out   conversation: nothing to do, it is in the ledger and every channel reads it with `sync`;
 *         notification / island / status / widget / chat pages: `present` frames to the channels that declared the surface
 *   words say, show, react, ask, open, card.update, card.draft, form (the contracts of sdk/words.ts)
 *
 * Cards in the conversation (`show {a2ui}`, `form`) are kept by ./cards: the newest version and what the owner entered
 * are what every channel draws (service:history reads them), and an owner's `say` that acts on a card saves its values.
 *
 * Cards on the home screen: `service:widgets` sends the event `widget.state` (to `person:owner`) with the whole state; it is
 * presented to every channel that declared `widget`, and what a channel reports becomes `widget.rendered`. A channel that
 * has just connected is given the current state from `service:widgets/widget.list`.
 *
 * Assembly: `link.onChannel("human", human.attach)`, `registry.add(human.member)`; the small model goes in as `summarize`
 * (`createSummarizer` of edges/llm/summary).
 */
import { isAgentId, OWNER_ID } from "../../../../../sdk/src/ids";
import type { HelloFrame } from "../../../../../sdk/src/link";
import {
  WordError, type Caller, type HandleContext, type Message, type Outgoing, type WordResult,
} from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Ledger } from "../../../kernel/ledger";
import type { Router } from "../../../kernel/types";
import type { ChannelAttach } from "../index";
import { Asks } from "./ask";
import { Cards, planOf } from "./cards";
import { formCard, Forms } from "./form";
import { CardRuntime } from "./runtime";
import { Clients, SURFACES, type ClientInfo, type LiveClient, type Surface } from "./clients";
import { Inbound, Recorded } from "./inbound";
import { Notifier } from "./notify";
import { Presenter, type PresentResult } from "./present";
import { TaskStatus, type Summarize } from "./status";
import { Syncs } from "./sync";

export { type Summarize, type TaskFrame } from "./status";
export { isQuiet, QUIET_HOURS_KEY, DEDUPE_MINUTES_KEY } from "./delivery";
export type { ClientInfo, Surface } from "./clients";
export type { PresentResult } from "./present";

export interface HumanDeps {
  router: Pick<Router, "send" | "subscribe">;
  ledger: Pick<Ledger, "db" | "page" | "get">;
  /** The hub's settings by key (`service:admin`); here only `delivery.quiet_hours` and `delivery.dedupe_minutes` are read. */
  settings(): Record<string, unknown>;
  /** The primary agent's id, or null while there is no agent: then replies on notifications have nobody to go to and are not sent. */
  primary(): string | null;
  /** One short line about what the agent is doing, from the small model; null when there is none. Absent: the tool's own line stays. */
  summarize?: Summarize;
  now?: () => number;
  /** Is this vault entry set? A form's password fields must be in the vault when the owner answers it. */
  vaultHas?: (ref: string) => boolean;
  /**
   * May agent [agent] make a card that belongs to app [app]? Only an app it published itself, or one whose every word its
   * declaration lets it call: a card runs as its app, so a narrowed agent cannot borrow an app's grants through one.
   * Not given: no agent attaches a card to an app.
   */
  /** Is a temporary app still used by a page or a home-screen widget (service:cards does not remove it then)? */
  appInUse?: (app: string) => Promise<boolean>;
  mayUseApp?: (agent: string, app: string) => boolean;
  /** Whether app [app] was approved to hear event [word] (its card's event sources); not given: no card hears events. */
  appHears?(app: string, word: string): boolean;
  /** IANA zone for quiet hours; default the host's local time. */
  timeZone?: string;
  log?: (message: string, error?: unknown) => void;
  timing?: Partial<{ presentMs: number; islandMs: number; recordMs: number; summaryDelayMs: number }>;
}

export interface HumanEdge {
  /** `person:owner`: add it to the registry. */
  member: Member;
  /** `service:cards`: the cards that hold resources and their lifecycle (docs/CARD-RUNTIME.md); add it to the registry too. */
  cards: Member;
  /** For `link.onChannel("human", …)`. */
  attach: ChannelAttach;
  clients(): ClientInfo[];
  /** The owner is looking at a live view (the virtual screen's preview) on some channel: that counts as using Ash. */
  viewing(): boolean;
  /** The channels open now, as little as the agents' environment needs (「主人在哪」): which kind, what it is called, local or not (whether it is being looked at is `clients()`, for delivery). */
  channels(): { client: string; kind: ClientInfo["channel"]; label: string; local: boolean }[];
  /**
   * Sends [bytes] to one channel as a stream (`stream` frames) and returns the stream id, which the answer to its word carries
   * (`service:blobs/get`). [client] is the channel the word came in through; throws `offline` when it is not connected.
   */
  openStream(client: string | undefined, bytes: Uint8Array, mime: string): string;
  /**
   * The owner's words after they answered the approval [askId]: sends [body] as a `say` to [to], as the owner, on the channel the
   * answer came from (counted once for one approval, however many times it is asked). False when the owner did not answer it (it ended by its time).
   */
  sayAfterAnswer(askId: string, to: string, body: Record<string, unknown>): Promise<boolean>;
  /** Brings a channel (default: the one the owner is on) to the front, e.g. after an authorization page. */
  focus(client?: string): Promise<PresentResult>;
  close(): void;
}


/** The member `person:owner` acting on its own (its events `typing` and `widget.rendered`, reading the widget state): the hub's code, not the owner speaking. */
const AS_SERVICE: Caller = { member: OWNER_ID, via: "service", local: true };

export function createHuman(deps: HumanDeps): HumanEdge {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message, error) => console.error(`[human] ${message}${error ? `: ${(error as Error).message}` : ""}`));
  const t = { presentMs: 10_000, islandMs: 1500, recordMs: 3000, ...deps.timing };
  const db = deps.ledger.db();

  const clients = new Clients(db, now);
  const presenter = new Presenter(t.presentMs);
  const recorded = new Recorded();
  const syncs = new Syncs(deps.ledger, log);

  const status = new TaskStatus({
    session: `ts_${now().toString(36)}`, primary: () => deps.primary(),
    asks: () => asks.list(),
    ...(deps.summarize ? { summarize: deps.summarize } : {}),
    ...(t.summaryDelayMs !== undefined ? { summaryDelayMs: t.summaryDelayMs } : {}),
    emit: (frame) => { for (const c of clients.withSurface("status")) void presenter.send(c, { surface: "status", op: "frame", body: frame as never }); },
  });
  const notifier: Notifier = new Notifier({
    clients, presenter, settings: deps.settings, now, islandMs: t.islandMs, ...(deps.timeZone ? { zone: deps.timeZone } : {}),
    primary: deps.primary,
  });
  const asks: Asks = new Asks({
    now,
    ended: (ask, notified) => notifier.hide(ask.id, notified),
    changed: () => status.asksChanged(),
  });
  const cards = new Cards(db, now);
  // The conversation's live cards: each change goes to every screen that shows the conversation, as one present frame.
  const runtime = new CardRuntime({
    db, cards, router: deps.router, ...(deps.appInUse ? { inUse: deps.appInUse } : {}), settings: deps.settings, now, log, ...(deps.appHears ? { hears: deps.appHears } : {}),
    viewing: () => clients.all().some((c) => c.visible),
    push: (card) => { for (const c of clients.withSurface("chat")) void presenter.send(c, { surface: "chat", op: "card.patch", body: { card } as never }); },
  });
  const forms: Forms = new Forms({ now, cards, vaultHas: deps.vaultHas ?? (() => false), changed: () => status.asksChanged() });
  const inbound = new Inbound({ router: deps.router, ledger: deps.ledger, recorded, asks, forms, now, recordMs: t.recordMs, log });

  const sendEvent = (out: Outgoing) => void deps.router.send(out, AS_SERVICE).then((reply) => { if (!reply.ok) log(`${out.word} to ${out.to} refused: ${reply.error.message}`); }, (error) => log(`${out.word} to ${out.to} failed`, error));

  // Everything the router announces: following syncs, answers waiting to be recorded, the task status, the turns that make replies ring.
  const unsubscribe = deps.router.subscribe({}, (m: Message) => {
    syncs.publish(m);
    if (m.from === OWNER_ID) recorded.offer(m);
    // The owner acted on a card: what was entered on it travels with the action and stays with the card.
    const acted = m.from === OWNER_ID && m.kind === "request" && m.word === "say" ? (m.body as { card?: { id?: unknown; action?: unknown; context?: { feedback?: unknown }; data?: unknown } } | null)?.card : undefined;
    if (acted && typeof acted.id === "string") {
      const row = cards.get(acted.id);
      const feedback = acted.action === "feedback" ? acted.context?.feedback : undefined;
      if (row && (feedback === "up" || feedback === "down")) cards.setFeedback(row.id, feedback);
      else if (row?.state === "open" && !row.form && acted.data && typeof acted.data === "object") { try { cards.draft(row, acted.data as Record<string, unknown>); } catch (error) { log(`card ${acted.id} values not kept`, error); } }
    }
    status.observe(m);
    const turn = (m.body as { turn?: unknown } | null)?.turn;
    if (m.kind === "event" && typeof turn === "string") {
      if (m.word === "turn.started") notifier.turnStarted(turn);
      else if (m.word === "turn.ended") void notifier.turnEnded(turn).catch((error) => log("turn end notification failed", error));
    }
  });

  // ---- the member -----------------------------------------------------------------------------------------------------

  const member: Member = {
    id: OWNER_ID, kind: "person", name: "Owner",
    words: (): WordContract[] => wordsOf(OWNER_ID),
    cancel: (id) => { asks.cancel(id); forms.cancel(id); },
    precheck: (msg) => {
      try { checkCard(msg); return null; } catch (error) {
        if (error instanceof WordError) return { ok: false, error: { code: error.code, message: error.message, ...(error.recovery_hint ? { recovery_hint: error.recovery_hint } : {}) } };
        throw error;
      }
    },
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as Record<string, any>;
      switch (msg.word) {
        case "widget.preview": return preview(body as { card: string; size?: string });
        case "widget.state": void pushWidgets(body, clients.withSurface("widget")); return;
        case "lease.state":
          for (const c of clients.withSurface("status")) void presenter.send(c, { surface: "status", op: "lease", body: { leases: Array.isArray(body.leases) ? body.leases : [] } });
          return;
        case "vscreen.state":
          for (const c of clients.withSurface("status")) void presenter.send(c, { surface: "status", op: "vscreen", body: { open: body.open === true } });
          return;
        case "say":
          void notifier.say(msg).catch((error) => log("notification failed", error));
          return { data: { accepted: true } };
        case "notice":
          void notifier.notice(msg).catch((error) => log("notification failed", error));
          return { data: { accepted: true } };
        case "show": {
          if (body.a2ui === undefined) return { data: { accepted: true } };
          const row = cards.put({ id: typeof body.id === "string" ? body.id : msg.id, message: msg.id, owner: msg.from, a2ui: body.a2ui, ...(typeof body.text === "string" ? { text: body.text } : {}) });
          // An app showing a card is the card's app (it cannot name another); an agent names an app it may use, else the card has none.
          let app = msg.from.startsWith("app:") ? msg.from.slice(4) : typeof body.app === "string" ? body.app : undefined;
          if (msg.from.startsWith("app:") && typeof body.app === "string" && body.app !== app) row.plan.problems.push(`app: an app's card belongs to the app itself (${app}), not to ${body.app}`);
          if (app && isAgentId(msg.from) && !(deps.mayUseApp?.(msg.from, app) ?? false)) {
            row.plan.problems.push(`app: ${msg.from} may not make cards of ${app} (only of an app it published, or one whose words its declaration covers), so this card has no app: its calls and live data do not run`);
            app = undefined;
          }
          // Only an app written for this card may go with it (removed when its cards close): never the owner's own apps.
          const temporary = !!app && body.temporary_app === true && await runtime.mayBeTemporary(app);
          if (app && body.temporary_app === true && !temporary) row.plan.problems.push(`temporary_app: ${app} is not an app written for this card (an agent's new app no lasting card uses), so it stays as it is; drop temporary_app`);
          runtime.register(row, { ...(app ? { app } : {}), temporary, ...(typeof body.ttl_min === "number" ? { ttl_min: body.ttl_min } : {}) });
          if (!app && Object.keys(row.plan.sources).length) row.plan.problems.push("a2ui.sources need the card's app (show {app}): a card without an app gets no live data");
          void notifier.say({ ...msg, body: { text: row.text } }).catch((error) => log("notification failed", error));
          return { data: { accepted: true, card: row.id, ...(row.plan.problems.length ? { problems: row.plan.problems } : {}), ...(row.plan.hints.length ? { hints: row.plan.hints } : {}) } };
        }
        case "card.update": {
          const row = ownCard(body.id, msg.from);
          const next = cards.update(row, { ...(body.a2ui ? { a2ui: body.a2ui } : {}), ...(body.data ? { data: body.data } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}) });
          runtime.changed(next.id);
          return { data: { updated: true, ...(next.plan.problems.length ? { problems: next.plan.problems } : {}), ...(next.plan.hints.length ? { hints: next.plan.hints } : {}) } };
        }
        case "card.close": {
          const row = cards.get(body.id);
          if (!row) throw new WordError("not_found", `no card ${body.id} in the conversation`);
          if (row.owner !== msg.from && !runtime.isApp(row, msg.from)) throw new WordError("forbidden", `card ${row.id} belongs to ${row.owner}; the owner closes it with service:cards/close`);
          return { data: { closed: runtime.closeCard(row.id) } };
        }
        case "card.draft": {
          const row = cards.get(body.card);
          if (!row) throw new WordError("not_found", `no card ${body.card}`);
          if (row.state !== "open") throw new WordError("conflict", "this card is closed");
          const next = cards.draft(row, body.data);
          const { problems: _problems, hints: _hints, ...plan } = next.plan;
          return { data: { card: next.id, plan } };
        }
        case "card.preview": return cardPreview(body as { id: string; theme?: string });
        case "form": {
          const built = formCard(body as Parameters<typeof formCard>[0]);
          const expires = Math.min(typeof body.expires_at === "number" ? body.expires_at : msg.ts + 24 * 3600_000, msg.ts + 7 * 24 * 3600_000);
          cards.put({ id: msg.id, message: msg.id, owner: msg.from, a2ui: built.a2ui, text: `需要你填：${body.title}`, form: { ...built.info, request: msg.id, expires_at: expires } });
          const done = forms.wait(msg, ctx.signal);
          void notifier.say({ ...msg, body: { text: `需要你填：${body.title}` } }).catch((error) => log("notification failed", error));
          return done;
        }
        case "react":
          if (!deps.ledger.get(body.message_id)) throw new WordError("not_found", `no message ${body.message_id}`);
          return { data: { accepted: true } };
        case "ask": {
          const { ask, done } = asks.wait(msg, ctx.signal);
          void notifier.ask(ask).then((reached) => {
            // The question may have ended while the notification was on its way.
            if (asks.has(ask.id)) for (const client of reached) asks.noted(ask.id, client);
            else notifier.hide(ask.id, reached);
          }).catch((error) => log("notification failed", error));
          return done;
        }
        case "open": return open(body as Parameters<typeof open>[0]);
        default: throw new WordError("not_found", `person:owner has no word ${msg.word}`);
      }
    },
  };

  /** A card [id] its creator [from] may change. */
  function ownCard(id: unknown, from: string) {
    const row = typeof id === "string" ? cards.get(id) : null;
    if (!row) throw new WordError("not_found", `no card ${String(id)} in the conversation`, { recovery_hint: "Show it first with person:owner/show {a2ui, id}." });
    if (row.owner !== from && !runtime.isApp(row, from)) throw new WordError("forbidden", `card ${row.id} belongs to ${row.owner}; only its creator or its app changes it`);
    if (row.form) throw new WordError("conflict", "a form card changes only by the owner's answer");
    return row;
  }

  /** Before anything is recorded: a card that cannot be drawn, or that names a card it may not, is refused with the reason. */
  function checkCard(msg: Message): void {
    const body = (msg.body ?? {}) as Record<string, any>;
    if (msg.word === "show" && body.a2ui !== undefined) {
      if (typeof body.id === "string" && cards.get(body.id)) throw new WordError("conflict", `there is a card ${body.id} already`, { recovery_hint: "Change it in place with person:owner/card.update {id, a2ui | data}, or show a new card under another id." });
      planOf(body.a2ui);
    } else if (msg.word === "card.update") {
      ownCard(body.id, msg.from);
      if (body.a2ui) planOf(body.a2ui);
    } else if (msg.word === "form") planOf(formCard(body as Parameters<typeof formCard>[0]).a2ui);
  }

  /** `card.preview`: the first channel that shows the conversation and can draw the card gives the picture (the phone; a web page cannot). */
  async function cardPreview(body: { id: string; theme?: string }): Promise<WordResult> {
    const row = cards.get(body.id);
    if (!row) throw new WordError("not_found", `no card ${body.id} in the conversation`);
    let failure: WordError = new WordError("offline", "no channel that can draw the card is connected (the phone draws it)");
    for (const c of clients.withSurface("chat")) {
      const result = await presenter.send(c, { surface: "chat", op: "card.preview", body: { card: { ...cards.item(row), ...runtime.extra(row.id) }, theme: body.theme === "dark" ? "dark" : "light" } as never });
      if (!result.ok) { failure = new WordError(result.error.code, result.error.message); continue; }
      const image = result.data as { type?: unknown; data?: unknown; width?: unknown; height?: unknown } | undefined;
      if (image?.type !== "image" || typeof image.data !== "string") continue;
      return { data: { card: row.id, width: image.width, height: image.height }, content: [result.data as never] };
    }
    throw failure;
  }

  /** `widget.preview`: the first channel that shows widgets and can draw the card gives the picture. */
  async function preview(body: { card: string; size?: string }): Promise<WordResult> {
    let failure: WordError = new WordError("offline", "no channel that shows widgets is connected");
    for (const c of clients.withSurface("widget")) {
      const result = await presenter.send(c, { surface: "widget", op: "preview", body: { card: body.card, size: body.size ?? "2x2" } });
      if (!result.ok) { failure = new WordError(result.error.code, result.error.message); continue; }
      const image = result.data as { type?: unknown } | undefined;
      return { data: result.data, ...(image?.type === "image" ? { content: [result.data as never] } : {}) };
    }
    throw failure;
  }

  /** `open`: a page on the named channel, else the one the owner is on. */
  async function open(body: { target: string; id?: string; mode?: string; client?: string }): Promise<WordResult> {
    const c = body.client ? clients.get(body.client) : clients.current();
    if (!c) throw new WordError("offline", body.client ? `${body.client} is not connected` : "the owner has no channel open");
    if (!c.surfaces.includes("chat")) throw new WordError("unavailable", `${c.client} does not show chat pages`);
    const result = await presenter.send(c, { surface: "chat", op: "open", body: { target: body.target, ...(body.id !== undefined ? { id: body.id } : {}), ...(body.mode !== undefined ? { mode: body.mode } : {}) } });
    if (!result.ok) throw new WordError(result.error.code, result.error.message);
    return { data: { opened: (result.data as { opened?: unknown } | undefined)?.opened !== false } };
  }

  // ---- the channels ---------------------------------------------------------------------------------------------------

  const attach: ChannelAttach = (session, ctx) => {
    const grant = session.channels.human;
    if (!grant || !("client" in grant)) return;
    const declared = (session.hello as HelloFrame).channels.human ?? {};
    const hand = session.hello.hand;
    const surfaces = (declared.surfaces ?? []).filter((s): s is Surface => (SURFACES as readonly string[]).includes(s));
    const at = now();
    const c: LiveClient = {
      client: grant.client, hand: `device:${ctx.handId}`, channel: hand.kind === "phone" ? "app" : hand.kind === "im" ? "im" : "web",
      ...(hand.kind === "im" ? { provider: hand.platform } : {}), label: declared.label ?? hand.name, local: ctx.local, surfaces,
      connected_at: at, last_seen: at, visible: false, visible_at: 0, active_at: at, watching: false, session,
    };
    clients.add(c);
    // After the welcome, which the link server sends right after this returns.
    setImmediate(() => {
      if (surfaces.includes("status")) void presenter.send(c, { surface: "status", op: "frame", body: status.frame() as never });
      if (surfaces.includes("widget")) greetWidgets(c);
      if (surfaces.includes("status")) greetLeases(c);
    });

    return {
      human(frame) {
        switch (frame.t) {
          case "send":
            clients.touch(c);
            void inbound.send(c, frame.request).then(
              (o) => session.send(o.ok ? { t: "send.result", id: frame.id, ok: true, message: o.message, ...(o.duplicate ? { duplicate: true } : {}), ...(o.response ? { response: o.response } : {}) } : { t: "send.result", id: frame.id, ok: false, error: o.error }),
              (error) => { log("send failed", error); session.send({ t: "send.result", id: frame.id, ok: false, error: { code: "internal", message: "the hub failed while handling this request" } }); },
            );
            return;
          case "sync": syncs.start(c, frame); return;
          case "sync.close": syncs.close(c, frame.sid); return;
          case "present.result": presenter.result(frame); return;
          case "presence":
            clients.touch(c);
            if (frame.visible !== undefined) { c.visible = frame.visible; if (frame.visible) c.visible_at = now(); }
            if (frame.watching !== undefined) c.watching = frame.watching;
            if (frame.typing === true && frame.agent && isAgentId(frame.agent)) sendEvent({ to: frame.agent, kind: "event", word: "typing", body: {} });
            return;
        }
      },
      closed() {
        syncs.closeAll(c);
        presenter.drop(c.client);
        clients.remove(c.client);
      },
    };
  };

  // ---- what other modules use -----------------------------------------------------------------------------------------

  /** Presents the whole widget state on [targets]; what each reports goes on as `widget.rendered`. */
  async function pushWidgets(state: unknown, targets: LiveClient[]): Promise<void> {
    const results = await Promise.all(targets.map((c) => presenter.send(c, { surface: "widget", op: "state", body: state as never })));
    for (const result of results) {
      if (!result.ok || !result.data || typeof result.data !== "object") continue;
      const data = result.data as { widgets?: unknown; rendered?: unknown };
      sendEvent({ to: "service:widgets", kind: "event", word: "widget.rendered", body: {
        ...(Array.isArray(data.widgets) ? { widgets: data.widgets } : {}), rendered: Array.isArray(data.rendered) ? data.rendered : [],
      } });
    }
  }

  /** A channel that shows status gets the screen leases in force now. */
  function greetLeases(c: LiveClient): void {
    void deps.router.send({ to: "service:gate", kind: "request", word: "lease.list", body: {} }, AS_SERVICE).then(
      (reply) => { if (reply.ok && reply.result?.data !== undefined) return presenter.send(c, { surface: "status", op: "lease", body: reply.result.data as never }); },
      (error) => log("lease.list failed", error),
    );
  }

  /** A channel that just connected gets the current state. */
  function greetWidgets(c: LiveClient): void {
    void deps.router.send({ to: "service:widgets", kind: "request", word: "widget.list", body: {} }, AS_SERVICE).then(
      (reply) => { if (reply.ok && reply.result?.data !== undefined) return pushWidgets(reply.result.data, [c]); },
      (error) => log("widget.list failed", error),
    );
  }

  return {
    member, attach, cards: runtime.member,
    openStream(client, bytes, mime) {
      const c = client ? clients.get(client) : undefined;
      if (!c) throw new WordError("unavailable", "this connection cannot receive a stream");
      return c.session.sendStream("human", bytes, { mime });
    },
    async sayAfterAnswer(askId, to, body) {
      const c = asks.takeAnswerer(askId);
      if (!c) return false;
      const sent = await inbound.send(c, { to, kind: "request", word: "say", body, client_id: `approval:${askId}` } as Parameters<Inbound["send"]>[1]);
      if (!sent.ok) throw new WordError(sent.error.code, sent.error.message);
      return true;
    },
    clients: () => clients.info(),
    viewing: () => clients.viewing(),
    channels: () => clients.all().map((c) => ({ client: c.client, kind: c.channel, label: c.label, local: c.local })),
    async focus(client) {
      const c = client ? clients.get(client) : clients.current();
      return c ? presenter.send(c, { surface: "chat", op: "focus", body: {} }) : { ok: false, error: { code: "offline", message: "the owner has no channel open" } };
    },
    close() { unsubscribe(); status.close(); runtime.close(); },
  };
}

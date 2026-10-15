/**
 * The host as a member (HUB-MODULES §2.8): `service:host`, whose words are the host client's calls, and the host's events
 * (the kernel's standard input) turned into words.
 *
 *   wake.fired      -> an event to `service:clock`
 *   env.changed     -> an event to `service:agents` and to `service:link` (whichever is there); a network change also to `onNetwork`
 *   lifecycle.stop  -> `onStop`, the shutdown the entry program handed over
 *
 * What the host does not offer is skipped, not imitated: its words answer `unavailable`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_ID } from "../../../../sdk/src/ids";
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { HostCapability, HostEvent, HostMethod, HostNetwork } from "../../../../sdk/src/host";
import type { ContentPart } from "../../../../sdk/src/link";
import { namespaceOf, standardContracts } from "../../../../sdk/src/namespaces";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Registry, Router } from "../../kernel/types";
import type { HostEventReader, HostPipe } from "./pipe";
import { HostCallError, type HostClient, type HostOptional } from "./client";
import type { VirtualScreen } from "./virtual";
import { phoneRelease, type PhoneRelease, type ReleaseOptions } from "./release";
import { PHONE_RELEASES } from "../../../../sdk/src/versions";

export const HOST_ID = "service:host";
const SELF: Caller = { member: HOST_ID, via: "service", local: true };
/** The vault entry of the read-only GitHub token for a private release repository. */
const GITHUB_TOKEN = "GITHUB_TOKEN";

/** The phone namespaces the host serves and the host capability that gates each: a word is listed only when the host has it. */
const PHONE_CAPABILITY: Readonly<Record<string, HostCapability>> = { vscreen: "vscreen", input: "input", apps: "apps" };
/** What the hand app itself does for `apps.open` when the host cannot (not paired): the agent sees one `apps.open`, here. */
const HAND_OPEN = "apps.open_direct";
/** The phone capability a word needs, or undefined for a word that is not a phone action. */
const phoneCapabilityOf = (word: string): HostCapability | undefined => PHONE_CAPABILITY[namespaceOf(word) ?? ""];

export interface HostServiceDeps {
  client: Pick<HostClient, "wakeAt" | "wakeClear" | "powerHold" | "powerRelease" | "handsHandoff" | "updateInstall" | "updateStatus" | "ctxList" | "ctxRead" | "lifecycleRestart" | "phone" | "has">;
  /** The vault entry GITHUB_TOKEN (a read-only token) reads a private release; it is handed to the host only, never to a word. */
  vault?: { use(ref: string): string | null };
  /** Finds a release of the phone's packages on GitHub (replaced in tests). */
  release?: (o: ReleaseOptions) => Promise<PhoneRelease>;
  router: Pick<Router, "send">;
  /** Finds the phone's hand, for the apps.open the host cannot do. */
  registry: Pick<Registry, "findByWord">;
  /** The virtual screen's bookkeeping: every vscreen.* call goes through it. */
  virtual: VirtualScreen;
  /** Where a finished screen recording goes: [hostDir] on this machine is [bodyDir] in the main body. Absent: recordings cannot be handed over. */
  recordings?: { hostDir: string; bodyDir: string };
  /** The host asked the kernel to stop before `deadline` (Unix ms). */
  onStop(deadline: number, reason: string): void | Promise<void>;
  /** The host's network changed (`env.changed`/`network`): the proxy to use from now on, or null for none. */
  onNetwork?(network: HostNetwork, online: boolean): void;
  log?(message: string, error?: unknown): void;
}

export interface HostService {
  /** `service:host`: add it to the registry. */
  member: Member;
  /** Takes the host's events from the pipe; `close()` stops reading. */
  listen(pipe: Pick<HostPipe, "events">): HostEventReader;
}

export function createHostService(deps: HostServiceDeps): HostService {
  const { client, router } = deps;
  const log = deps.log ?? (() => {});
  const done = <R>(r: HostOptional<R>): WordResult => {
    if (!r.supported) throw new WordError("unavailable", "the host does not offer this");
    return { data: (r.result ?? {}) as object };
  };

  // The phone actions (the virtual screen, keys, launching an app) live on this member too (sdk standardMember), but only
  // while the host can do them: the ones whose capability the host did not declare are left out of the list ("部位不在就不列").
  const phoneWords = standardContracts().filter((c) => c.member === HOST_ID);

  const member: Member = {
    id: HOST_ID, kind: "service", name: "host",
    // apps.open is always listed: with the host's `apps` it goes through the host, without it through the hand app (viaHand).
    words: () => [...wordsOf(HOST_ID), ...phoneWords.filter((c) => c.word === "apps.open" || client.has(phoneCapabilityOf(c.word)!))],
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      const b = (msg.body ?? {}) as Record<string, any>;
      if (msg.word === "apps.open" && !client.has("apps")) return viaHand(b, ctx);
      if (phoneCapabilityOf(msg.word)) return phone(msg.word as HostMethod, b, ctx?.caller?.turn, ctx?.caller?.member);
      switch (msg.word) {
        case "wake.at": return done(await client.wakeAt(b.at));
        case "wake.clear": return done(await client.wakeClear());
        case "power.hold": return done(await client.powerHold(b.ms, b.reason));
        case "power.release": return done(await client.powerRelease());
        case "hands.handoff": return done(await client.handsHandoff(b.port, b.token));
        case "update.install": return updatePhone(b.version);
        case "update.status": return done(await client.updateStatus());
        case "ctx.list": return hostCall(() => client.ctxList());
        case "ctx.read": return hostCall(() => client.ctxRead({ day: b.day, file: b.file, ...(b.offset !== undefined ? { offset: b.offset } : {}), ...(b.limit !== undefined ? { limit: b.limit } : {}) }));
        // The answer goes out first: the restart takes this process with it.
        case "restart": setTimeout(() => { client.lifecycleRestart(String(b.reason ?? "restart asked")).catch((error) => log("lifecycle.restart failed", error)); }, 300).unref(); return { data: { restarting: true } };
        default: throw new WordError("not_found", `${HOST_ID} has no word ${msg.word}`);
      }
    },
  };

  /** A host call whose errors (a bad day, the host gone) are the word's; unavailable when the host does not have it (no debug identity). */
  async function hostCall<R>(call: () => Promise<HostOptional<R>>): Promise<WordResult> {
    try { return done(await call()); }
    catch (error) { if (error instanceof HostCallError) throw new WordError(error.code, error.message); throw error; }
  }

  /** Finds the release on GitHub (its SHA256SUMS), then has the host download, check and install it. */
  async function updatePhone(version: string | undefined): Promise<WordResult> {
    if (!client.has("update")) throw new WordError("unavailable", "this host cannot install updates");
    const token = deps.vault?.use(GITHUB_TOKEN) ?? null;
    const release = await (deps.release ?? phoneRelease)({ repo: PHONE_RELEASES, ...(version ? { version } : {}), token });
    let r: HostOptional<{ started: true; via: "shell" | "installer" }>;
    try { r = await client.updateInstall({ version: release.version, packages: release.packages, ...(token ? { token } : {}) }); }
    catch (error) { if (error instanceof HostCallError) throw new WordError(error.code, error.message); throw error; }
    if (!r.supported) throw new WordError("unavailable", "this host cannot install updates");
    log(`installing ${release.version} on the phone (${r.result.via})`);
    return { data: { started: true, version: release.version, via: r.result.via, packages: release.packages.map((p) => p.package) } };
  }

  /** Forward one phone word to the host and shape its reply: data follows the word, the host's `message` and (for see) the JPEG become content. */
  async function phone(word: HostMethod, body: Record<string, any>, turn: string | undefined, caller?: string): Promise<WordResult> {
    let r: HostOptional<Record<string, any>>;
    try {
      r = word.startsWith("vscreen.") ? await deps.virtual.call(word, body, turn) : await client.phone(word, body as never);
    } catch (error) {
      if (error instanceof HostCallError) throw new WordError(error.code, error.message);
      throw error;
    }
    if (!r.supported) throw new WordError("unavailable", "the phone cannot do this now: pair the phone's debug identity (「后台也能动手」)");
    if (word === "apps.open" || word === "input.key") deps.virtual.noteScreenChanged();
    const res = r.result as Record<string, any>;
    if (word === "vscreen.record.stop") {
      const saved = await saveRecording(res as RecordingInfo);
      if (caller === OWNER_ID) await showRecording(saved);
      return { data: saved, content: [{ type: "text", text: recordingText(saved) }] };
    }
    if (word === "vscreen.see") {
      const { screenW: sw, screenH: sh, imageW: iw, imageH: ih, displayId, jpeg } = res;
      const caption = sw === iw && sh === ih
        ? `Virtual screen (display ${displayId}) ${sw}x${sh}; image pixels = tap coordinates.`
        : `Virtual screen (display ${displayId}) ${sw}x${sh}; image ${iw}x${ih}: multiply image coordinates by ${(iw > 0 ? sw / iw : 1).toFixed(4)} for vscreen.tap/swipe.`;
      const content: ContentPart[] = [{ type: "text", text: caption }, { type: "image", mime: "image/jpeg", b64: jpeg }];
      return { content };
    }
    const { message, ...data } = res;
    const out: WordResult = {};
    if (Object.keys(data).length > 0) out.data = data;
    if (typeof message === "string" && message.length > 0) out.content = [{ type: "text", text: message }];
    return out;
  }

  interface RecordingInfo { path: string; seconds: number; bytes: number; reason: string }
  interface SavedRecording { path: string; name: string; seconds: number; bytes: number; reason: string }
  const recordingText = (r: SavedRecording): string =>
    `Recording saved: ${r.path} (${r.seconds.toFixed(1)} s, ${(r.bytes / 1_048_576).toFixed(1)} MB${r.reason === "stopped" ? "" : `, stopped: ${r.reason}`}).`;

  /** Copies the host's finished video into the main body's work directory and says where it is there. */
  async function saveRecording(r: RecordingInfo): Promise<SavedRecording> {
    const rec = deps.recordings;
    if (!rec) throw new WordError("unavailable", "this hub has no place to keep recordings");
    const name = `vscreen-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.mp4`;
    try {
      await mkdir(rec.hostDir, { recursive: true });
      await copyFile(r.path, join(rec.hostDir, name));
    } catch (error) {
      throw new WordError("failed", `could not take the recording from the host: ${(error as Error).message}`);
    }
    return { path: `${rec.bodyDir}/${name}`, name, seconds: r.seconds, bytes: r.bytes, reason: r.reason };
  }

  /** The finished video as a file card in the owner's conversation. */
  async function showRecording(r: SavedRecording): Promise<void> {
    const card = { type: "file", workspace: "body:main", path: r.path, name: r.name, mime_type: "video/mp4", size: r.bytes };
    try {
      const reply = await router.send({ to: OWNER_ID, kind: "request", word: "show", body: { card } }, SELF);
      if (!reply.ok && reply.error.code !== "offline") log(`recording card: ${reply.error.code}: ${reply.error.message}`);
    } catch (error) { log("recording card failed", error); }
  }

  /** The screen closed: a recording that was still running, or had stopped by itself, goes to the owner now (nobody else may ever ask for it). */
  async function collectRecording(): Promise<void> {
    if (!client.has("vscreen")) return;
    try {
      const r = await client.phone("vscreen.record.stop", {});
      if (r.supported) await showRecording(await saveRecording(r.result as RecordingInfo));
    } catch (error) {
      if (!(error instanceof HostCallError && error.code === "bad_request")) log("recording on close failed", error);
    }
  }

  /** `apps.open` without the host's `apps`: the hand app opens it itself (it is in front, or accessibility / overlay lets it), and says what to turn on when the system blocks it. */
  async function viaHand(body: Record<string, any>, ctx: HandleContext): Promise<WordResult> {
    const hand = deps.registry.findByWord(HAND_OPEN, { kind: "device" })[0]?.id;
    if (!hand) throw new WordError("unavailable", "the phone's app is not connected, and the host cannot open apps without the debug identity pairing");
    const turn = ctx?.caller?.turn;
    const reply = await router.send({ to: hand, kind: "request", word: HAND_OPEN, body }, turn ? { ...SELF, turn } : SELF, ctx?.signal ? { signal: ctx.signal } : undefined);
    if (!reply.ok) throw new WordError(reply.error.code, reply.error.message, reply.error.recovery_hint ? { recovery_hint: reply.error.recovery_hint } : {});
    deps.virtual.noteScreenChanged();
    return reply.result ?? {};
  }

  const pass = async (to: string, word: string, body: object): Promise<void> => {
    const reply = await router.send({ to, kind: "event", word, body }, SELF);
    if (!reply.ok && reply.error.code !== "offline") log(`${word} to ${to}: ${reply.error.code}: ${reply.error.message}`);
  };

  // The owner's screens show or hide the live preview when the virtual screen is made or closed.
  deps.virtual.subscribe((open) => {
    void pass("person:owner", "vscreen.state", { open }).catch((error) => log("vscreen.state failed", error));
    if (!open) void collectRecording();
  });

  return {
    member,
    listen: (pipe) => pipe.events(async (event: HostEvent) => {
      switch (event.event) {
        case "wake.fired": await pass("service:clock", "wake.fired", { at: event.at }); return;
        case "env.changed": {
          const { event: _name, ...rest } = event;
          if (event.what === "network") deps.onNetwork?.(event.network, event.online);
          await Promise.all([pass("service:agents", "env.changed", rest), pass("service:link", "env.changed", rest)]);
          return;
        }
        case "lifecycle.stop": await deps.onStop(event.deadline, event.reason); return;
      }
    }),
  };
}

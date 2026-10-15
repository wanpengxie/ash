// `service:apps`: the words of the app edge (SPEC-02 §4.1). Each word is a thin call into the runtime; the checks, the
// install card and the grants are the runtime's. Who may call which word, and the approval of an agent's install or
// enable, are the contracts' and the gate's business, not repeated here.
import { APP_SCHEMA, SYSTEM_APPS, systemAppInfo } from "../../../../sdk/src/app";
import { errorBody, WordError, type HandleContext, type Message, type Reply, type WordResult } from "../../../../sdk/src/message";
import { APP_CONTRACT } from "../../../../sdk/src/versions";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { scaffoldFiles } from "./scaffold";
import type { AppRuntime } from "./runtime";

export const APPS_ID = "service:apps";

const text = (body: Record<string, unknown>, key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

export function createAppsService(runtime: AppRuntime): Member {
  async function run(msg: Message, ctx: HandleContext): Promise<WordResult> {
    const body = msg.body as Record<string, unknown>;
    const id = text(body, "id");
    const system = SYSTEM_APPS.find((app) => app.id === id);
    if (system && !["apps.list", "apps.refresh", "apps.describe"].includes(msg.word))
      throw new WordError("forbidden", "system apps are updated with Ash");
    switch (msg.word) {
      // The system apps first (they come with Ash), then the installed ones.
      case "apps.list": return { data: { apps: [...SYSTEM_APPS.map(systemAppInfo), ...runtime.list()] } };
      case "apps.refresh": await runtime.refresh(); return { data: { apps: [...SYSTEM_APPS.map(systemAppInfo), ...runtime.list()] } };
      case "apps.describe": {
        if (system) return { data: systemAppInfo(system) };
        // The hub starts the clock before the apps: until the apps are loaded "not found" would be a guess (the clock asks this to
        // tell a removed app from one that has not come up yet).
        if (!runtime.isStarted()) throw new WordError("unavailable", "the apps are still loading", { recovery_hint: "Try again in a moment." });
        const info = runtime.info(id);
        if (!info) throw new WordError("not_found", `no app ${id}`, { recovery_hint: "apps.list shows what exists." });
        return { data: info };
      }
      case "apps.install": return { data: await runtime.install(id, ctx.caller, msg.id) };
      case "apps.enable": return { data: await runtime.enable(id) };
      case "apps.disable": return { data: await runtime.disable(id) };
      case "apps.revoke": return { data: await runtime.revoke(id, typeof body.need === "string" ? body.need : undefined) };
      case "apps.badge": {
        if (!ctx.caller.member.startsWith("app:")) throw new WordError("forbidden", "an app sets the dot of its own icon");
        return { data: runtime.setBadge(ctx.caller.member.slice(4), body.tone as "ok" | "warn" | "err" | "paused") };
      }
      case "apps.sleep": return { data: await runtime.sleep(id) };
      case "apps.wake": return { data: await runtime.wake(id) };
      case "apps.restart": return { data: await runtime.restart(id) };
      case "apps.logs": return { data: runtime.logs(id, typeof body.lines === "number" ? body.lines : 100) };
      case "apps.reset": return { data: await runtime.reset(id) };
      case "apps.remove": return { data: await runtime.remove(id, body.keep_data === true) };
      case "apps.validate": {
        if (!id && typeof body.path !== "string") throw new WordError("bad_request", "要给 id（应用文件夹名）或 path");
        return { data: await runtime.validate(id ? { id } : { path: String(body.path) }) };
      }
      case "apps.scaffold": {
        const made = runtime.scaffold(body as Parameters<AppRuntime["scaffold"]>[0], ctx.caller.member);
        return { data: made };
      }
      case "apps.contract": {
        const { doc, docPath } = runtime.contract();
        const example = scaffoldFiles({ id: "hello", name: "Hello", summary: "A small example app: a list with a page and four tools.", publisher: "ash" });
        return { data: { contract: APP_CONTRACT, doc, doc_path: docPath, schema: APP_SCHEMA, example: { files: example } } };
      }
      case "apps.surface": {
        const surface = text(body, "surface");
        const page = await runtime.surface(id, surface);
        return { data: { id, surface, mime: page.mime, html: page.html, csp: page.csp } };
      }
      case "apps.icon": {
        const icon = runtime.icon(id);
        return { data: { id, mime: icon.mime, data: icon.data } };
      }
      default: throw new WordError("not_found", `${APPS_ID} has no word ${msg.word}`);
    }
  }

  return {
    id: APPS_ID,
    kind: "service",
    name: "apps",
    words: (): WordContract[] => wordsOf(APPS_ID),
    /** An app that would not install is refused before anyone is asked: static checks of the folder. */
    precheck(msg: Message): Reply | null {
      if (msg.word !== "apps.install") return null;
      const report = runtime.precheckInstall(text(msg.body as Record<string, unknown>, "id"));
      if (!report) return null;
      const refusal = runtime.refusal(report);
      return { ok: false, error: errorBody(refusal.code, refusal.message, { detail: refusal.detail, recovery_hint: refusal.recovery_hint }) };
    },
    /** The gate puts this under the approval card of an install: what the app needs and listens to. */
    cardDetail(msg: Message): string | null {
      return msg.word === "apps.install" ? runtime.cardDetail(text(msg.body as Record<string, unknown>, "id"), msg.id) : null;
    },
    handle: run,
  };
}

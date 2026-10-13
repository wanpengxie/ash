/**
 * The device channel of this computer (SPEC-03 §4): what it declares and how it answers a call or an assessment.
 *
 * It declares `workspace.*` and `body.info` always; the hub registers them as `body:<id>` only while the owner has bound
 * this computer, and everything else as `device:<id>` (the hand). Browser actions appear while the browser is there.
 */
import type { CallFrame, CapabilitySpec } from "../../sdk/src/link";
import { WordError } from "../../sdk/src/message";
import type { Risk } from "../../sdk/src/word";
import type { CallOutcome, HandHandlers } from "../../link/src/hand";
import type { Workspace } from "../../workspace/src";
import type { Browser } from "./browser";
import { EGO_CAPABILITY } from "./browser";
import type { KimiBrowser } from "./kimi";
import type { CodexApp } from "./codex-app";
import { redactText } from "./redact";
import { expandHome, isBodyCapability, workspaceCapabilities } from "./workspace";

/** The one caller allowed to update this program: the hub's `service:devices` (SPEC-03 §9). */
export const UPDATER = "service:devices";

export const UPDATE_CAPABILITY: CapabilitySpec = {
  name: "x.ash.update", label: "在更新电脑端程序",
  description: "Install an approved official release of the computer program (version and SHA-256) and restart it. Only the hub's device service calls this, after the owner approved the update.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["version", "sha256"],
    properties: { version: { type: "string", pattern: "^v?\\d+\\.\\d+\\.\\d+$" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  },
  effect: "execute", risk: "structure", callers: ["kernel"], timeout_ms: 180_000,
};

export interface HandParts {
  workspace: Workspace;
  /** ego-browser, when installed. */
  ego?: Browser | null;
  kimi?: KimiBrowser | null;
  /** The Codex desktop app's channel; its capabilities are declared while the app is running. */
  codex?: CodexApp | null;
  /** Installs the release and restarts; absent when this copy was not installed by the service installer. */
  update?: ((version: string, sha256: string) => Promise<unknown>) | null;
  /** Something is running that an update must not interrupt (agent turns). */
  busy?: () => boolean;
}

export interface Hand {
  /** The capabilities to declare now. */
  manifest(): CapabilitySpec[];
  handlers: Required<Pick<HandHandlers, "call" | "assess">>;
  readonly inflight: number;
}

const failure = (error: unknown, aborted: boolean): CallOutcome => {
  if (error instanceof WordError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}), ...(error.recovery_hint ? { recovery_hint: error.recovery_hint } : {}) } };
  }
  return { ok: false, error: { code: aborted ? "cancelled" : "failed", message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 2000) } };
};

export function createHand(parts: HandParts): Hand {
  let inflight = 0;
  const manifest = (): CapabilitySpec[] => [
    ...workspaceCapabilities(),
    ...(parts.kimi?.capabilities() ?? []),
    ...(parts.codex?.capabilities() ?? []),
    ...(parts.ego ? [EGO_CAPABILITY] : []),
    ...(parts.update ? [UPDATE_CAPABILITY] : []),
  ];

  async function dispatch(frame: CallFrame, signal: AbortSignal): Promise<CallOutcome> {
    const name = frame.capability;
    if (isBodyCapability(name)) {
      const done = await parts.workspace.call(name, expandHome(frame.args), { signal });
      return { ok: true, content: done.content, data: done.data };
    }
    if (name === EGO_CAPABILITY.name) {
      if (!parts.ego) throw new WordError("unavailable", "ego-browser is not installed on this computer");
      return parts.ego.call(frame.args, frame.caller.member, signal);
    }
    if (name === UPDATE_CAPABILITY.name) {
      if (frame.caller.member !== UPDATER) throw new WordError("forbidden", "Only the hub's device service updates this program");
      const { version, sha256 } = frame.args;
      if (!parts.update) throw new WordError("unavailable", "This device was not installed with the service installer");
      if (typeof version !== "string" || !/^v?\d+\.\d+\.\d+$/.test(version) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new WordError("bad_request", "Invalid approved update");
      if (inflight > 1 || parts.busy?.()) throw new WordError("conflict", "Finish or stop active tasks before updating");
      const result = await parts.update(version, sha256);
      return { ok: true, content: [{ type: "text", text: JSON.stringify(result ?? {}) }], data: (result ?? {}) as Record<string, unknown> };
    }
    if (name.startsWith("x.codex.")) {
      if (!parts.codex?.online) throw new WordError("unavailable", "The Codex app is not running on this computer");
      return parts.codex.call(name, frame.args, signal);
    }
    if (name.startsWith("browser.") || name.startsWith("x.kimi.")) {
      if (!parts.kimi?.online) throw new WordError("unavailable", "The browser extension is not connected");
      return parts.kimi.call(name, frame.args, frame.caller.member, signal);
    }
    throw new WordError("not_found", `This computer does not offer ${name}`);
  }

  return {
    manifest,
    get inflight() { return inflight; },
    handlers: {
      async call(frame, ctx) {
        inflight++;
        try { return await dispatch(frame, ctx.signal); } catch (error) { return failure(error, ctx.signal.aborted); } finally { inflight--; }
      },
      async assess(capability, args): Promise<{ risk: Risk; why?: string }> {
        if (isBodyCapability(capability)) return { risk: await parts.workspace.assess(capability, args) };
        // Anything else has no per-call answer: the declared risk stands.
        const declared = manifest().find((c) => c.name === capability);
        return { risk: declared?.risk ?? "structure" };
      },
    },
  };
}

/**
 * Host contract `ash-host/1` (SPEC-07): what the kernel host tells the kernel at start (host.json, named by one environment
 * variable, and the secrets as the first line on the kernel's standard input), what the kernel may ask of the host and what
 * the host pushes to the kernel. The host and the kernel it started talk over the kernel's own standard input and output
 * only: a private pipe, no port, no token. JSON lines both ways:
 *   host -> kernel (stdin):  {"boot":{"seal_key":…}} first, then {"reply":id,…} answers and host events {"event":…}
 *   kernel -> host (stdout): {"call":id,"method":…,"params":{…}}
 * The kernel writes its log to standard error only.
 * Types and the JSON Schema of host.json live here and nowhere else; `schema/host.json` is generated from
 * HOST_SPEC_SCHEMA (tools/gen-host-schema.mjs) and a test keeps the two in step.
 */

import { HOST_CONTRACT } from "./versions";
import type { ErrorCode } from "./message";

export { HOST_CONTRACT };

/** The one variable the host sets when it starts the kernel. Secrets are never in the environment. */
export const HOST_ENV = {
  /** Absolute path of host.json. */
  spec: "ASH_HOST_SPEC",
} as const;

/** Exit code of a kernel that cannot run on the host it was given (BSD EX_CONFIG). */
export const HOST_EXIT_CONFIG = 78;
/** The kernel calls status.set this often; the host treats silence as a stuck kernel. */
export const HOST_HEARTBEAT_MS = 60_000;
/** Upper bound of one power.hold. */
export const HOST_POWER_HOLD_MAX_MS = 600_000;

// ---- capabilities --------------------------------------------------------------------------------------------------

export const HOST_REQUIRED_CAPABILITIES = ["identity", "lifecycle", "status"] as const;
export const HOST_OPTIONAL_CAPABILITIES = ["wake", "power", "hands", "update", "vscreen", "input", "apps", "ctx"] as const;
export type HostRequiredCapability = (typeof HOST_REQUIRED_CAPABILITIES)[number];
export type HostOptionalCapability = (typeof HOST_OPTIONAL_CAPABILITIES)[number];
export type HostCapability = HostRequiredCapability | HostOptionalCapability;
export const HOST_CAPABILITIES: readonly HostCapability[] = [...HOST_REQUIRED_CAPABILITIES, ...HOST_OPTIONAL_CAPABILITIES];

export type HostSecureStorage = "keystore" | "keychain" | "tpm" | "file" | "none";
export const HOST_SECURE_STORAGE: readonly HostSecureStorage[] = ["keystore", "keychain", "tpm", "file", "none"];

// ---- host.json -----------------------------------------------------------------------------------------------------

export interface HostProxy { http?: string; https?: string; no_proxy?: string }
/** `null` means no proxy. */
export interface HostNetwork { proxy: HostProxy | null }

export interface HostProotIsolation {
  kind: "proot";
  proot: {
    root: string; rootfs: string; bin: string; loader: string; lib: string;
    storage_binds?: string[]; dns?: string[];
  };
}
export interface HostNativeIsolation { kind: "native"; native: {
  workspace: string; dsh_bin: string; dsh_home: string;
  /** The `--patch` file for DSH on this machine (inside the container it is /opt/ash/patch.yml). Absent: DSH runs without one. */
  dsh_patch?: string;
} }
export interface HostContainerIsolation { kind: "container"; container: { engine: string; image: string } }
export type HostIsolation = HostProotIsolation | HostNativeIsolation | HostContainerIsolation;

export interface HostDirs {
  /** Ledger, vault, member state. */
  state: string;
  /** Ash's home: the host-side path of /root/work in the main body. */
  home: string;
  tmp: string;
  /** Node, git, python and friends. */
  runtime: string;
  logs: string;
}

export interface HostSpec {
  contract: typeof HOST_CONTRACT;
  /** The host's own kind and version; only for logs and diagnostics. */
  host: { kind: string; version: string };
  platform: { os: string; os_version?: string; arch: string; model?: string; locale?: string; timezone?: string };
  dirs: HostDirs;
  isolation: HostIsolation;
  network?: HostNetwork;
  /** Capability groups the host has. Names this kernel does not know are ignored (new optional ones keep `ash-host/1`). */
  capabilities: string[];
  secure_storage: HostSecureStorage;
  /** Only a debug build of the host sets these: `owner_token` lets a host without secure storage run; `script_agent` declares the script agent (`agent:script`), which does what a message says instead of thinking. */
  dev?: { owner_token?: boolean; script_agent?: boolean };
}

// ---- the pipe ------------------------------------------------------------------------------------------------------

/** The first line on the kernel's standard input: the secrets. `seal_key` is the vault's 32-byte key, base64url. */
export interface HostBootLine { boot: { seal_key: string } }
/** A call of the kernel to the host, one line on the kernel's standard output. */
export interface HostCallLine { call: number; method: string; params: unknown }
/** The host's answer to call `reply`, one line on the kernel's standard input. */
export type HostReplyLine = { reply: number } & HostResponse<unknown>;

// ---- host interface (kernel -> host) -------------------------------------------------------------------------------

export type HostStatusState = "starting" | "running" | "degraded" | "stopping";
export const HOST_STATUS_STATES: readonly HostStatusState[] = ["starting", "running", "degraded", "stopping"];

/** Request and result of every method; `{}` is an empty JSON object. */
export interface HostMethods {
  "identity.key": { req: Record<string, never>; res: { id: string; public_key: string } };
  "identity.sign": { req: { data: string }; res: { sig: string } };
  "lifecycle.ready": { req: { version: string; link_port: number }; res: Record<string, never> };
  "lifecycle.restart": { req: { reason: string }; res: Record<string, never> };
  "status.set": { req: { text: string; state: HostStatusState }; res: Record<string, never> };
  "wake.at": { req: { at: number }; res: Record<string, never> };
  "wake.clear": { req: Record<string, never>; res: Record<string, never> };
  "power.hold": { req: { ms: number; reason: string }; res: Record<string, never> };
  "power.release": { req: Record<string, never>; res: Record<string, never> };
  "hands.handoff": { req: { port: number; token: string }; res: { delivered: string[] } };
  /**
   * Starts installing a release of Ash's packages (ai.ash.agent, then ai.ash.kernel) in the background and answers at once:
   * each APK is downloaded, checked against its SHA-256, and only then installed — with `pm install` by the debug identity
   * (`via: "shell"`), or by the system installer, which asks the owner to confirm each package (`via: "installer"`).
   * `token` reads a private repository's assets (sent to api.github.com only). Installing the kernel restarts the core.
   */
  "update.install": { req: { version: string; packages: { package: string; url: string; sha256: string }[]; token?: string }; res: { started: true; via: "shell" | "installer" } };
  /** The running or last update: `state` idle | downloading | installing | waiting_user | done | failed, with `version` and `message`. */
  "update.status": { req: Record<string, never>; res: { state: string; version?: string; message?: string; at?: number } };
  /**
   * What the phone's context probe recorded (capability ctx, the kernel host with the debug identity: only it can read the
   * files). `ctx.list`: every day with each file's size and line count (estimated for big files), and the probe's state.
   * `ctx.read`: a piece of one file by bytes, whole lines; the host makes the path from `day` and `file`, nothing else.
   */
  "ctx.list": { req: Record<string, never>; res: { probe: CtxProbeState; days: { day: string; files: CtxFileInfo[] }[] } };
  "ctx.read": { req: { day: string; file: CtxFile; offset?: number; limit?: number }; res: { day: string; file: CtxFile; offset: number; next_offset: number; size: number; eof: boolean; text: string } };
  // The phone-action groups the kernel host serves (capability vscreen/input/apps). The host does the Android work and
  // returns structured data (plus a short `message` for the reply, and the JPEG for vscreen.see); the kernel builds the
  // word's content. Absent when the host cannot do them (unpaired: only `input`, media and volume keys).
  "vscreen.create": { req: { orientation?: string; short_edge?: number; dpi?: number }; res: { displayId: number; width: number; height: number; dpi: number; reused: boolean; message: string } };
  "vscreen.status": { req: Record<string, never>; res: { running: boolean; displayId?: number; width?: number; height?: number; dpi?: number; recording?: boolean; recordMs?: number } };
  "vscreen.launch": { req: { app: string }; res: { package: string; component: string; message: string } };
  "vscreen.see": { req: { max_side?: number; quality?: number }; res: { jpeg: string; displayId: number; screenW: number; screenH: number; imageW: number; imageH: number } };
  "vscreen.tap": { req: { x: number; y: number }; res: { message: string } };
  "vscreen.swipe": { req: { x1: number; y1: number; x2: number; y2: number; duration_ms?: number }; res: { message: string } };
  "vscreen.key": { req: { key: string; long_press?: boolean }; res: { message: string } };
  "vscreen.type": { req: { text: string }; res: { message: string } };
  "vscreen.close": { req: Record<string, never>; res: { message: string } };
  /** Records the virtual screen to a video file on the phone (a path the core can read); `vscreen.record.stop` hands it over. */
  "vscreen.record.start": { req: { max_seconds?: number }; res: { startedAt: number; maxSeconds: number; message: string } };
  "vscreen.record.stop": { req: Record<string, never>; res: { path: string; seconds: number; bytes: number; reason: string } };
  "input.key": { req: { key: string; long_press?: boolean }; res: { message: string } };
  "apps.open": { req: { app: string }; res: { package: string; opened: boolean; message: string } };
}
export type HostMethod = keyof HostMethods;

/** Which capability group a method belongs to. */
export const HOST_METHOD_CAPABILITY: { readonly [M in HostMethod]: HostCapability } = {
  "identity.key": "identity",
  "identity.sign": "identity",
  "lifecycle.ready": "lifecycle",
  "lifecycle.restart": "lifecycle",
  "status.set": "status",
  "wake.at": "wake",
  "wake.clear": "wake",
  "power.hold": "power",
  "power.release": "power",
  "hands.handoff": "hands",
  "update.install": "update",
  "update.status": "update",
  "ctx.list": "ctx",
  "ctx.read": "ctx",
  "vscreen.create": "vscreen",
  "vscreen.status": "vscreen",
  "vscreen.launch": "vscreen",
  "vscreen.see": "vscreen",
  "vscreen.tap": "vscreen",
  "vscreen.swipe": "vscreen",
  "vscreen.key": "vscreen",
  "vscreen.type": "vscreen",
  "vscreen.close": "vscreen",
  "vscreen.record.start": "vscreen",
  "vscreen.record.stop": "vscreen",
  "input.key": "input",
  "apps.open": "apps",
};

/** The context probe's four files (JSON lines), one set per day. */
export const CTX_FILES = ["events", "screens", "touch", "stats"] as const;
export type CtxFile = (typeof CTX_FILES)[number];
/** Most bytes one `ctx.read` returns. */
export const CTX_READ_MAX = 262_144;
export interface CtxProbeState { state: "running" | "paused" | "stopped"; since?: number; last_exit?: string }
export interface CtxFileInfo { file: CtxFile; bytes: number; lines: number; lines_estimated: boolean; modified: number }

/** Error codes of the host interface: the shared set (SPEC-02 section 7). */
export type HostErrorCode = ErrorCode;

export type HostResponse<R> = { ok: true; result: R } | { ok: false; error: { code: HostErrorCode; message: string } };

// ---- host events (host -> kernel, JSON lines on stdin) -------------------------------------------------------------

export interface HostWakeFired { event: "wake.fired"; at: number }
export interface HostNetworkChanged { event: "env.changed"; what: "network"; network: HostNetwork; online: boolean }
export interface HostPowerChanged { event: "env.changed"; what: "power"; saver: boolean }
export interface HostLifecycleStop { event: "lifecycle.stop"; deadline: number; reason: string }
export type HostEnvChanged = HostNetworkChanged | HostPowerChanged;
export type HostEvent = HostWakeFired | HostEnvChanged | HostLifecycleStop;

// ---- JSON Schema of host.json --------------------------------------------------------------------------------------

const str = { type: "string", minLength: 1 } as const;
const strList = { type: "array", items: { type: "string" } } as const;
const proxy = {
  type: "object",
  properties: { http: { type: "string" }, https: { type: "string" }, no_proxy: { type: "string" } },
} as const;

/** JSON Schema (draft-07 vocabulary) of host.json. Unknown extra fields are allowed: adding fields keeps `ash-host/1`. */
export const HOST_SPEC_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "ash-host/1/host.json",
  title: "ash-host/1 launch description (host.json)",
  type: "object",
  required: ["contract", "host", "platform", "dirs", "isolation", "capabilities", "secure_storage"],
  properties: {
    contract: { const: HOST_CONTRACT },
    host: { type: "object", required: ["kind", "version"], properties: { kind: str, version: str } },
    platform: {
      type: "object",
      required: ["os", "arch"],
      properties: {
        os: str, os_version: { type: "string" }, arch: str, model: { type: "string" }, locale: { type: "string" }, timezone: { type: "string" },
      },
    },
    dirs: {
      type: "object",
      required: ["state", "home", "tmp", "runtime", "logs"],
      properties: { state: str, home: str, tmp: str, runtime: str, logs: str },
    },
    isolation: {
      oneOf: [
        {
          type: "object",
          required: ["kind", "proot"],
          properties: {
            kind: { const: "proot" },
            proot: {
              type: "object",
              required: ["root", "rootfs", "bin", "loader", "lib"],
              properties: { root: str, rootfs: str, bin: str, loader: str, lib: str, storage_binds: strList, dns: strList },
            },
          },
        },
        {
          type: "object",
          required: ["kind", "native"],
          properties: {
            kind: { const: "native" },
            native: { type: "object", required: ["workspace", "dsh_bin", "dsh_home"], properties: { workspace: str, dsh_bin: str, dsh_home: str, dsh_patch: str } },
          },
        },
        {
          type: "object",
          required: ["kind", "container"],
          properties: {
            kind: { const: "container" },
            container: { type: "object", required: ["engine", "image"], properties: { engine: str, image: str } },
          },
        },
      ],
    },
    network: { type: "object", required: ["proxy"], properties: { proxy: { oneOf: [{ type: "null" }, proxy] } } },
    capabilities: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    secure_storage: { enum: [...HOST_SECURE_STORAGE] },
    dev: { type: "object", properties: { owner_token: { type: "boolean" }, script_agent: { type: "boolean" } } },
  },
} as const;

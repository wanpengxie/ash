// The Android host, seen from ash core. The host (Kotlin app) runs a loopback HTTP service
// and ash core is its client:
//   GET  /manifest   → the phone's capabilities (notifications, clipboard, accessibility, shell …)
//   POST /call       → run one capability                  POST /notify  → Android notification
//   POST /confirm    → confirmation notification with ✓/✗   POST /confirm/hide
//   POST /alarm      → wake ash core at the next timer (AlarmManager survives doze and kills)
//   GET  /key, POST /sign → the phone's gateway identity, kept in the Android Keystore
// Answers flow back through the normal SDK with the host's own token (member device:phone).

import type { CallResult, CapabilitySpec, Confirmation, DeviceInfo } from "../../sdk/src/api";
import { type Core, PHONE } from "./core";
import type { Signer } from "./gateway/link";

export interface HostOptions {
  url: string; // http://127.0.0.1:<port>
  token: string;
}

export class HostBridge {
  private refresh: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly core: Core,
    private readonly opts: HostOptions,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.opts.url + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`host ${path}: ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Register the phone as a device and wire notifications, confirmations and wake-ups to the host. */
  async start(): Promise<void> {
    await this.syncManifest();
    this.refresh = setInterval(() => void this.syncManifest().catch(() => this.core.devices.setOnline(PHONE, false)), 60_000);
    this.core.addNotifier(async (n) => {
      await this.req("POST", "/notify", n);
    });
    this.core.addConfirmPresenter({
      show: (c: Confirmation) => this.req("POST", "/confirm", c),
      hide: (id: string) => this.req("POST", "/confirm/hide", { id }),
    });
    this.core.onNextTimer((at) => void this.req("POST", "/alarm", { at }).catch((e) => this.core.log("host alarm failed:", e.message)));
  }

  private async syncManifest(): Promise<void> {
    const m = await this.req<{ name?: string; capabilities: CapabilitySpec[] }>("GET", "/manifest");
    const info: DeviceInfo = { id: PHONE, name: m.name ?? "手机", kind: "phone", online: true, via: "host", permissions: [], capabilities: m.capabilities ?? [] };
    this.core.devices.upsert(info, {
      call: (capability, args, ctx) => this.req<CallResult>("POST", "/call", { capability, args, caller: ctx.caller }, 180_000),
    });
  }

  /** The phone's gateway identity: the private key never leaves the Keystore. */
  async signer(): Promise<Signer> {
    const k = await this.req<{ id: string; publicKey: string }>("GET", "/key");
    return {
      id: k.id,
      publicKey: k.publicKey,
      sign: async (data: Uint8Array) => (await this.req<{ sig: string }>("POST", "/sign", { data: Buffer.from(data).toString("base64url") })).sig,
    };
  }

  /** Ask the host to restart ash core (e.g. after a plugin change DSH cannot hot-reload). */
  async restart(): Promise<void> {
    await this.req("POST", "/restart", {});
  }

  stop(): void {
    if (this.refresh) clearInterval(this.refresh);
  }
}

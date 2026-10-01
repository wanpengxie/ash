import type { CallResult } from "../../sdk/src/api";
import type { HostManifestV2 } from "../../sdk/src/host";
import { DeviceMember } from "./members/device";
import type { Signer } from "./gateway/link";
import type { DeviceCapability } from "./world/router";
import type { WorldMembers } from "./world/member";

export interface HostConnection { url: string; token: string }

/** Host I/O never passes through the retired v1 event writer. */
export class HostDeviceLink {
  private refresh: ReturnType<typeof setInterval> | null = null;
  private member: DeviceMember | null = null;
  private refreshEpoch = 0;
  private closed = false;
  private constructor(readonly config: HostConnection, private currentManifest: HostManifestV2) {}

  get manifest(): HostManifestV2 { return structuredClone(this.currentManifest); }

  private static validatedManifest(raw: unknown): HostManifestV2 {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid host manifest");
    const manifest = raw as HostManifestV2;
    if (typeof manifest.name !== "string" || !manifest.name.trim() || !Array.isArray(manifest.capabilities)) throw new TypeError("invalid host manifest");
    for (const capability of manifest.capabilities) {
      if (!capability || typeof capability.name !== "string" || !capability.name.trim() || typeof capability.description !== "string" || !capability.description.trim() ||
        typeof capability.label !== "string" || !capability.label.trim() || !["none", "outward", "structure"].includes(capability.risk) ||
        !capability.input_schema || typeof capability.input_schema !== "object" || Array.isArray(capability.input_schema)) throw new TypeError("host capability lacks required v2 metadata");
    }
    return structuredClone(manifest);
  }

  static async probe(config: HostConnection): Promise<HostDeviceLink> {
    const raw = await HostDeviceLink.request(config, "GET", "/manifest");
    return new HostDeviceLink(config, HostDeviceLink.validatedManifest(raw));
  }

  private static async request(config: HostConnection, method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    const result = await fetch(new URL(path, config.url), { method,
      headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!result.ok) throw new Error(`host ${path} failed (${result.status})`);
    return result.json();
  }
  private request(method: string, path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> { return HostDeviceLink.request(this.config, method, path, body, timeoutMs, signal); }

  device(): DeviceMember {
    if (this.closed) throw new Error("device host is closed");
    if (this.member) return this.member;
    const capabilities: DeviceCapability[] = this.currentManifest.capabilities.map((item) => ({ name: item.name, description: item.description, input_schema: item.input_schema, risk: item.risk, label: item.label }));
    const member = new DeviceMember("device:phone", this.currentManifest.name, capabilities, async (message, context) => {
      try {
        const result = await this.request("POST", "/call", { capability: message.word, args: message.body, caller: message.from }, 180_000, context.signal) as CallResult;
        if (!result || typeof result.ok !== "boolean") throw new Error("invalid host result");
        return result.ok ? { ok: true, result: { content: result.content, ...(result.data === undefined ? {} : { data: result.data }) } }
          : { ok: false, error: { code: "failed", message: result.error ?? "device call failed" } };
      } catch {
        if (!this.closed && this.member === member) member.setOnline(false);
        return { ok: false, error: { code: "offline", message: "device host unavailable" } };
      }
    });
    this.member = member;
    return member;
  }

  /** Invalid/partial updates leave the last snapshot describable but offline. */
  async refreshManifest(members: WorldMembers): Promise<void> {
    if (this.closed) return;
    const epoch = ++this.refreshEpoch;
    try {
      const next = HostDeviceLink.validatedManifest(await this.request("GET", "/manifest"));
      if (this.closed || epoch !== this.refreshEpoch) return;
      if (JSON.stringify(next) === JSON.stringify(this.currentManifest)) { this.member?.setOnline(true); return; }
      const old = this.member;
      const previousManifest = this.currentManifest;
      try {
        this.currentManifest = next;
        this.member = null;
        members.replaceDevice(this.device());
      } catch (error) {
        this.currentManifest = previousManifest;
        this.member = old;
        old?.setOnline(false);
        throw error;
      }
    } catch { if (!this.closed && epoch === this.refreshEpoch) this.member?.setOnline(false); }
  }

  startHealthChecks(members: WorldMembers): void {
    if (this.closed || this.refresh) return;
    this.refresh = setInterval(() => void this.refreshManifest(members), 60_000);
  }
  /** Confirm the Android host has replaced or cancelled its one core wake alarm. */
  async scheduleAlarm(at: number | null): Promise<void> {
    if (this.closed || (at !== null && (!Number.isSafeInteger(at) || at < 0))) throw new TypeError("invalid host alarm time");
    const result = await this.request("POST", "/alarm", { at }) as { ok?: unknown };
    if (!result || result.ok !== true) throw new Error("host alarm acknowledgement unavailable");
  }
  async signer(): Promise<Signer> {
    const key = await this.request("GET", "/key") as { id: string; publicKey: string };
    if (!key || typeof key.id !== "string" || typeof key.publicKey !== "string") throw new TypeError("invalid host gateway key");
    return { id: key.id, publicKey: key.publicKey, sign: async (data: Uint8Array) => {
      const response = await this.request("POST", "/sign", { data: Buffer.from(data).toString("base64url") }) as { sig: string };
      return response.sig;
    } };
  }
  close(): void { this.closed = true; this.refreshEpoch++; if (this.refresh) clearInterval(this.refresh); this.refresh = null; this.member?.setOnline(false); }
}

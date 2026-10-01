import type { CallResult } from "../../sdk/src/api";
import type { HostManifestV2 } from "../../sdk/src/host";
import { DeviceMember } from "./members/device";
import type { Signer } from "./gateway/link";
import type { DeviceCapability } from "./world/router";

export interface HostConnection { url: string; token: string }

/** Host I/O never passes through the retired v1 event writer. */
export class HostDeviceLink {
  private refresh: ReturnType<typeof setInterval> | null = null;
  private member: DeviceMember | null = null;
  private constructor(readonly config: HostConnection, readonly manifest: HostManifestV2) {}

  static async probe(config: HostConnection): Promise<HostDeviceLink> {
    const raw = await HostDeviceLink.request(config, "GET", "/manifest");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid host manifest");
    const manifest = raw as HostManifestV2;
    if (typeof manifest.name !== "string" || !manifest.name.trim() || !Array.isArray(manifest.capabilities)) throw new TypeError("invalid host manifest");
    for (const capability of manifest.capabilities) {
      if (!capability || typeof capability.name !== "string" || !capability.name.trim() || typeof capability.description !== "string" || !capability.description.trim() ||
        typeof capability.label !== "string" || !capability.label.trim() || !["none", "outward", "structure"].includes(capability.risk) ||
        !capability.input_schema || typeof capability.input_schema !== "object" || Array.isArray(capability.input_schema)) throw new TypeError("host capability lacks required v2 metadata");
    }
    return new HostDeviceLink(config, structuredClone(manifest));
  }

  private static async request(config: HostConnection, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const result = await fetch(new URL(path, config.url), { method,
      headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!result.ok) throw new Error(`host ${path} failed (${result.status})`);
    return result.json();
  }
  private request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> { return HostDeviceLink.request(this.config, method, path, body, timeoutMs); }

  device(): DeviceMember {
    if (this.member) return this.member;
    const capabilities: DeviceCapability[] = this.manifest.capabilities.map((item) => ({ name: item.name, description: item.description, input_schema: item.input_schema, risk: item.risk, label: item.label }));
    this.member = new DeviceMember("device:phone", this.manifest.name, capabilities, async (message) => {
      try {
        const result = await this.request("POST", "/call", { capability: message.word, args: message.body, caller: message.from }, 180_000) as CallResult;
        if (!result || typeof result.ok !== "boolean") throw new Error("invalid host result");
        return result.ok ? { ok: true, result: { content: result.content, ...(result.data === undefined ? {} : { data: result.data }) } }
          : { ok: false, error: { code: "failed", message: result.error ?? "device call failed" } };
      } catch { this.member?.setOnline(false); return { ok: false, error: { code: "offline", message: "device host unavailable" } }; }
    });
    return this.member;
  }

  startHealthChecks(): void {
    if (this.refresh) return;
    this.refresh = setInterval(() => void this.request("GET", "/manifest").then((raw) => {
      const next = raw as HostManifestV2;
      // A changed capability set needs a new registration cycle; never silently reinterpret an existing route.
      this.member?.setOnline(JSON.stringify(next.capabilities) === JSON.stringify(this.manifest.capabilities));
    }).catch(() => this.member?.setOnline(false)), 60_000);
  }
  async signer(): Promise<Signer> {
    const key = await this.request("GET", "/key") as { id: string; publicKey: string };
    if (!key || typeof key.id !== "string" || typeof key.publicKey !== "string") throw new TypeError("invalid host gateway key");
    return { id: key.id, publicKey: key.publicKey, sign: async (data: Uint8Array) => {
      const response = await this.request("POST", "/sign", { data: Buffer.from(data).toString("base64url") }) as { sig: string };
      return response.sig;
    } };
  }
  close(): void { if (this.refresh) clearInterval(this.refresh); this.refresh = null; this.member?.setOnline(false); }
}

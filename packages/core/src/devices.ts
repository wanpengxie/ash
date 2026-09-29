// Devices and what they can do. A device is a member (`device:<id>`) with a self-described
// capability manifest and a provider that knows how to reach it: the Android host on this
// phone, a paired laptop behind the gateway, or this process itself.

import type { CallResult, CapabilitySpec, DeviceInfo } from "../../sdk/src/api";

export interface CallContext {
  caller: string;
  signal?: AbortSignal;
}

export interface DeviceProvider {
  call(capability: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallResult>;
}

interface Entry {
  info: DeviceInfo;
  provider: DeviceProvider | null;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, Entry>();
  private readonly listeners = new Set<(d: DeviceInfo) => void>();

  /** Add or update a device; notifies listeners only when something visible changed. */
  upsert(info: DeviceInfo, provider?: DeviceProvider | null): void {
    const prev = this.devices.get(info.id);
    const next: Entry = { info, provider: provider === undefined ? (prev?.provider ?? null) : provider };
    this.devices.set(info.id, next);
    if (!prev || JSON.stringify(prev.info) !== JSON.stringify(info)) for (const l of this.listeners) l(info);
  }

  setOnline(id: string, online: boolean): void {
    const e = this.devices.get(id);
    if (e && e.info.online !== online) this.upsert({ ...e.info, online });
  }

  setCapabilities(id: string, capabilities: CapabilitySpec[]): void {
    const e = this.devices.get(id);
    if (e) this.upsert({ ...e.info, capabilities });
  }

  remove(id: string): void {
    const e = this.devices.get(id);
    if (!e) return;
    this.devices.delete(id);
    for (const l of this.listeners) l({ ...e.info, online: false, capabilities: [] });
  }

  get(id: string): DeviceInfo | undefined {
    return this.devices.get(id)?.info;
  }

  provider(id: string): DeviceProvider | null {
    return this.devices.get(id)?.provider ?? null;
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((e) => e.info);
  }

  onChange(fn: (d: DeviceInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const text = (t: string): CallResult => ({ ok: true, content: [{ type: "text", text: t }] });
export const fail = (error: string): CallResult => ({ ok: false, content: [{ type: "text", text: error }], error });

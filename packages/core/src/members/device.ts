import type { Message, ResponseBody } from "../../../sdk/src/api";
import type { DeviceCapability, RouteHandlerContext } from "../world/router";
import type { DeviceMemberLike } from "../world/member";

export type DeviceExecutor = (message: Message, context: RouteHandlerContext) => Promise<ResponseBody | void> | ResponseBody | void;

/** A real routing adapter: discovery supplies its manifest, executor and current connection state. */
export class DeviceMember implements DeviceMemberLike {
  readonly kind = "device" as const;
  private available: boolean;
  private readonly manifest: readonly DeviceCapability[];

  constructor(readonly id: string, readonly name: string, capabilities: readonly DeviceCapability[],
    private readonly execute: DeviceExecutor, online = true, private readonly cancelEffect?: (requestId: string) => void,
    private readonly assessCall?: (message: Message, signal: AbortSignal) => Promise<"none" | null>) {
    this.manifest = structuredClone(capabilities);
    this.available = online;
  }

  get online(): boolean { return this.available; }
  setOnline(online: boolean): void {
    if (typeof online !== "boolean") throw new TypeError("online must be boolean");
    this.available = online;
  }
  capabilities(): readonly DeviceCapability[] { return structuredClone(this.manifest); }
  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> | ResponseBody | void {
    if (!this.available) return { ok: false, error: { code: "offline", message: "device offline" } };
    return this.execute(message, context);
  }
  cancel(requestId: string): void { this.cancelEffect?.(requestId); }
  /** Asked only for a capability the device marked per_call_risk; an offline device declares nothing. */
  async assess(message: Message, signal: AbortSignal): Promise<"none" | null> {
    if (!this.available || !this.assessCall || this.manifest.find((c) => c.name === message.word)?.per_call_risk !== true) return null;
    return await this.assessCall(message, signal) === "none" ? "none" : null;
  }
}

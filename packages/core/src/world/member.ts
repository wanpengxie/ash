import type { DescribeDetail, DescribeSummary, MemberInfo, Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { RouterError, WorldRouter, type DeviceCapability, type DeviceEndpointOptions, type RouteHandlerContext, type RouteEndpoint } from "./router";

/** One member owns its words and handles only messages addressed to itself. */
export interface Member extends MemberInfo {
  words(): readonly WordSpec[];
  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> | ResponseBody | void;
  cancel?(requestId: string): void;
  /** Names of words whose intake is durably deduplicated by message id. */
  idempotentRecovery?: readonly string[];
}

/** External device schemas are compiled by the router's standards-compliant validator. */
export interface DeviceMemberLike extends MemberInfo {
  kind: "device";
  online: boolean;
  capabilities(): readonly DeviceCapability[];
  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> | ResponseBody | void;
  cancel?(requestId: string): void;
  /** The device's own risk for one call of a word whose risk depends on its arguments (RouteEndpoint.assess). */
  assess?(message: Message, signal: AbortSignal): Promise<"none" | null>;
}

/** An app's tools, mapped by the app runtime to capabilities with ash's own risk and label. */
export interface AppMemberLike extends MemberInfo {
  kind: "app";
  online: boolean;
  capabilities(): readonly DeviceCapability[];
  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> | ResponseBody | void;
}

interface RegisteredMember {
  info: Omit<MemberInfo, "online">;
  online: () => boolean | undefined;
  words: readonly WordSpec[];
}

const deviceOptions = (member: DeviceMemberLike): DeviceEndpointOptions =>
  ({ ...(member.cancel ? { cancel: member.cancel.bind(member) } : {}), ...(member.assess ? { assess: member.assess.bind(member) } : {}) });
const memberIdPattern = /^(person|screen|agent|device|service|worker|app):[A-Za-z0-9_-]+$/;
const clone = <T>(value: T): T => structuredClone(value);

function validInfo(member: MemberInfo): Omit<MemberInfo, "online"> {
  if (!member || typeof member.id !== "string" || !memberIdPattern.test(member.id) || member.id.split(":")[0] !== member.kind ||
    typeof member.name !== "string" || !member.name.trim() || (member.online !== undefined && typeof member.online !== "boolean")) {
    throw new TypeError("invalid member information");
  }
  return { id: member.id, kind: member.kind, name: member.name };
}

/** Directory and router share the same validated word snapshots. Registration has one publish point. */
export class WorldMembers {
  private readonly members = new Map<string, RegisteredMember>();
  private screenDirectory: (() => { id: string; name: string; online: boolean }[]) | null = null;
  private screenWord: WordSpec | null = null;
  constructor(readonly router: WorldRouter) {}

  /** A stored validated manifest may be offline, but never absent or inferred from an old wildcard. */
  canGrantDeviceAccess(agentId: string, deviceId: string, capability: string): boolean {
    const agent = this.members.get(agentId);
    const device = this.members.get(deviceId);
    return agent?.info.kind === "agent" && device?.info.kind === "device" &&
      device.words.some((word) => word.word === capability && word.kind === "request" &&
        (word as WordSpec & { direction?: string }).direction !== "out");
  }

  /** Ephemeral screen information is projected from the authenticated registry; routing uses its one validated wildcard word. */
  setScreenDirectory(list: () => { id: string; name: string; online: boolean }[], word: WordSpec): void {
    if (this.screenDirectory && this.screenDirectory !== list) throw new TypeError("screen directory already installed");
    this.screenDirectory = list; this.screenWord = clone(word);
  }

  register(member: Member): void {
    const info = validInfo(member);
    if (this.members.has(info.id)) throw new TypeError("duplicate member");
    const words = member.words();
    if (!Array.isArray(words)) throw new TypeError("invalid member words");
    const idempotent = member.idempotentRecovery;
    if (idempotent !== undefined && (!Array.isArray(idempotent) || idempotent.some((word) => typeof word !== "string"))) throw new TypeError("invalid recovery declaration");
    for (const spec of words) {
      const direction = (spec as WordSpec & { direction?: unknown }).direction;
      if (direction !== undefined && direction !== "in") throw new TypeError("member cannot register an outbound word as inbound");
    }
    const handle = member.handle.bind(member);
    const cancel = member.cancel?.bind(member);
    const endpoints: RouteEndpoint[] = words.map((spec) => ({ member: info.id, spec, handle, ...(cancel ? { cancel } : {}), idempotentRecovery: idempotent?.includes(spec.word) ?? false }));
    const validated = this.router.registerBatch(endpoints);
    this.members.set(info.id, { info, online: () => member.online, words: validated });
  }

  registerDevice(member: DeviceMemberLike): void {
    const info = validInfo(member);
    if (info.kind !== "device" || this.members.has(info.id)) throw new TypeError("duplicate or invalid device member");
    const capabilities = member.capabilities();
    if (!Array.isArray(capabilities)) throw new TypeError("invalid device capabilities");
    const validated = this.router.registerDeviceBatch(info.id, capabilities, member.handle.bind(member), deviceOptions(member));
    this.members.set(info.id, { info, online: () => member.online, words: validated });
  }

  /** One validated manifest snapshot drives both describe and send; in-flight old calls are cancelled. */
  replaceDevice(member: DeviceMemberLike): void {
    const info = validInfo(member);
    if (info.kind !== "device") throw new TypeError("device member required");
    if (!this.members.has(info.id)) { this.registerDevice(member); return; }
    const capabilities = member.capabilities();
    if (!Array.isArray(capabilities)) throw new TypeError("invalid device capabilities");
    const validated = this.router.replaceDeviceBatch(info.id, capabilities, member.handle.bind(member), deviceOptions(member));
    this.members.set(info.id, { info, online: () => member.online, words: validated });
    this.router.cancelMember(info.id);
  }

  removeDevice(memberId: string): void {
    const existing = this.members.get(memberId);
    if (!existing) return;
    if (existing.info.kind !== "device") throw new TypeError("cannot remove a non-device member");
    this.router.unregisterDevice(memberId);
    this.members.delete(memberId);
    this.router.cancelMember(memberId);
  }

  /** An app (contract ash-app/1) is registered like a device: its tools are compiled as external capabilities. Re-registering replaces. */
  registerApp(member: AppMemberLike): void {
    const info = validInfo(member);
    if (info.kind !== "app") throw new TypeError("app member required");
    const capabilities = member.capabilities();
    if (!Array.isArray(capabilities)) throw new TypeError("invalid app capabilities");
    const handle = member.handle.bind(member);
    const validated = this.members.has(info.id) ? this.router.replaceDeviceBatch(info.id, capabilities, handle) : this.router.registerDeviceBatch(info.id, capabilities, handle);
    const replaced = this.members.has(info.id);
    this.members.set(info.id, { info, online: () => member.online, words: validated });
    if (replaced) this.router.cancelMember(info.id);
  }

  removeApp(memberId: string): void {
    const existing = this.members.get(memberId);
    if (!existing) return;
    if (existing.info.kind !== "app") throw new TypeError("cannot remove a non-app member");
    this.router.unregisterDevice(memberId);
    this.members.delete(memberId);
    this.router.cancelMember(memberId);
  }

  /** Take a removed declared agent out of the world. */
  unregisterAgent(memberId: string): void {
    if (!this.members.has(memberId)) return;
    this.router.unregisterAgent(memberId);
    this.members.delete(memberId);
    this.router.cancelMember(memberId);
  }

  describe(audience: "owner" | "agent"): DescribeSummary;
  describe(audience: "owner" | "agent", memberId: string): DescribeDetail;
  describe(audience: "owner" | "agent", memberId?: string): DescribeSummary | DescribeDetail {
    if (audience !== "owner" && audience !== "agent") throw new TypeError("invalid describe audience");
    const visible = (item: RegisteredMember) => item.words.filter((word) => word.audience === undefined || word.audience === "all" || word.audience === audience);
    const info = (item: RegisteredMember): MemberInfo => {
      const online = item.online();
      return { ...item.info, ...(online === undefined ? {} : { online }) };
    };
    const screens = this.screenDirectory?.().filter((screen) => memberIdPattern.test(screen.id)) ?? [];
    if (memberId !== undefined && screens.some((screen) => screen.id === memberId)) {
      const screen = screens.find((item) => item.id === memberId)!;
      return { members: [{ ...screen, kind: "screen", words: [clone(this.screenWord!)] }] };
    }
    if (memberId !== undefined) {
      const item = this.members.get(memberId);
      if (!item || !visible(item).length) throw new RouterError("not_found", "member not found");
      return { members: [{ ...info(item), words: visible(item).map(clone) }] };
    }
    return { members: [...this.members.values()].filter((item) => visible(item).length > 0).map((item) => ({ ...info(item), words: visible(item).map((word) => word.word).sort() }))
      .concat(screens.map((screen) => ({ ...screen, kind: "screen" as const, words: [this.screenWord!.word] })))
      .sort((a, b) => a.id.localeCompare(b.id)) };
  }
}

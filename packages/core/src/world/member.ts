import type { DescribeDetail, DescribeSummary, MemberInfo, Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { RouterError, WorldRouter, type DeviceCapability, type RouteHandlerContext, type RouteEndpoint } from "./router";

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
}

interface RegisteredMember {
  info: Omit<MemberInfo, "online">;
  online: () => boolean | undefined;
  words: readonly WordSpec[];
}

const memberId = /^(person|screen|agent|device|service|worker):[A-Za-z0-9_-]+$/;
const clone = <T>(value: T): T => structuredClone(value);

function validInfo(member: MemberInfo): Omit<MemberInfo, "online"> {
  if (!member || typeof member.id !== "string" || !memberId.test(member.id) || member.id.split(":")[0] !== member.kind ||
    typeof member.name !== "string" || !member.name.trim() || (member.online !== undefined && typeof member.online !== "boolean")) {
    throw new TypeError("invalid member information");
  }
  return { id: member.id, kind: member.kind, name: member.name };
}

/** Directory and router share the same validated word snapshots. Registration has one publish point. */
export class WorldMembers {
  private readonly members = new Map<string, RegisteredMember>();
  constructor(readonly router: WorldRouter) {}

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
    const handle = member.handle.bind(member);
    const cancel = member.cancel?.bind(member);
    const validated = this.router.registerDeviceBatch(info.id, capabilities, handle, cancel ? { cancel } : {});
    this.members.set(info.id, { info, online: () => member.online, words: validated });
  }

  /** One validated manifest snapshot drives both describe and send; in-flight old calls are cancelled. */
  replaceDevice(member: DeviceMemberLike): void {
    const info = validInfo(member);
    if (info.kind !== "device") throw new TypeError("device member required");
    if (!this.members.has(info.id)) { this.registerDevice(member); return; }
    const capabilities = member.capabilities();
    if (!Array.isArray(capabilities)) throw new TypeError("invalid device capabilities");
    const handle = member.handle.bind(member);
    const cancel = member.cancel?.bind(member);
    const validated = this.router.replaceDeviceBatch(info.id, capabilities, handle, cancel ? { cancel } : {});
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

  describe(audience: "owner" | "agent"): DescribeSummary;
  describe(audience: "owner" | "agent", memberId: string): DescribeDetail;
  describe(audience: "owner" | "agent", memberId?: string): DescribeSummary | DescribeDetail {
    if (audience !== "owner" && audience !== "agent") throw new TypeError("invalid describe audience");
    const visible = (item: RegisteredMember) => item.words.filter((word) => word.audience === undefined || word.audience === "all" || word.audience === audience);
    const info = (item: RegisteredMember): MemberInfo => {
      const online = item.online();
      return { ...item.info, ...(online === undefined ? {} : { online }) };
    };
    if (memberId !== undefined) {
      const item = this.members.get(memberId);
      if (!item || !visible(item).length) throw new RouterError("not_found", "member not found");
      return { members: [{ ...info(item), words: visible(item).map(clone) }] };
    }
    return { members: [...this.members.values()].filter((item) => visible(item).length).sort((a, b) => a.info.id.localeCompare(b.info.id))
      .map((item) => ({ ...info(item), words: visible(item).map((word) => word.word).sort() })) };
  }
}

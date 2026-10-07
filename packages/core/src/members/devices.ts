import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEVICE_WORDS } from "../../../sdk/src/device-words";
import type { Message, ResponseBody } from "../../../sdk/src/api";
import type { Member } from "../world/member";
import type { RouteHandlerContext, TrustedRouteContext, WorldRouter } from "../world/router";

/** Transport is injected at composition; this member owns policy, not connections. */
export interface DeviceManagementLink {
  connected: boolean; lastError: string;
  pending: Map<string, { request_id: string; client_id: string; name: string; fingerprint: string }>;
  state(): Record<string, unknown>;
  ticket(): Promise<{ ticket: string; gateway: string; expires_in: number }>;
  approve(id: string, permissions: ("chat" | "web_ui" | "expose_capability")[]): Promise<void>;
  reject(id: string): Promise<void>; revoke(id: string): Promise<void>;
  refreshDevices(): Promise<void>; setWebUi(id: string, allow: boolean): Promise<void>;
  closeAgentChannel(id: string): void;
  updateDevice?(id: string, version: string, sha256: string): Promise<unknown>;
}

interface Policy { name: string; kind: "laptop" | "server" | "browser"; access: "approval" | "full"; local_agents: boolean; web_ui: boolean; paired_at: number }
/** The one pairing code in use. It lives only here: never in a result, the ledger or anything an agent can read. */
interface PairingCode { ticket: string; gateway: string; kind: string; issued_at: number; expires_at: number; used_at?: number }
/** What the owner's devices page shows about the code: the code itself only while it can still be used. */
export interface PairingView { revision: string; code: null | { state: "active" | "used" | "expired"; kind: string; gateway: string;
  expires_in_ms: number; ticket?: string; install_command?: string } }

/** The published installer; it takes the gateway and the code and pairs the computer. */
export const DEVICE_INSTALLER = "https://github.com/wanpengxie/ash/releases/download/device-v0.1.0/install.sh";
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
export const installCommand = (gateway: string, ticket: string): string => `curl -fsSL ${DEVICE_INSTALLER} | sh -s -- ${quote(gateway)} ${quote(ticket)}`;
/** A name another device chose for itself, safe inside an owner notice. */
const label = (name: unknown): string => String(name ?? "").replace(/[\p{C}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40) || "一台新设备";
const service: TrustedRouteContext = { member: "service:devices", transport: "service", transportPrincipal: "service:devices", local: true, remote: false, ownerProxy: false };
export class DevicesMember implements Member {
  readonly id = "service:devices"; readonly kind = "service" as const; readonly name = "设备管理"; readonly online = true;
  readonly idempotentRecovery = ["list", "describe", "pair_pending", "diagnose", "gateway_status", "gateway_setup_guide"];
  private policies: Record<string, Policy> = {};
  private code: PairingCode | null = null;
  /** Owner notices wait until the world has recovered; then they are sent as they happen. */
  private notices: (() => void)[] | null = [];
  constructor(private file: string, private link: () => DeviceManagementLink | null, private router: WorldRouter) {
    if (existsSync(file)) this.policies = JSON.parse(readFileSync(file, "utf8")).devices ?? {};
    router.setDevicePolicy(member => this.policy(member));
    router.setDeviceManagementApproval(request => this.needsApproval(request.word, request.body));
    router.setDeviceManagementCard(request => this.approvalCard(request));
  }
  words() { return DEVICE_WORDS; }
  /** Call after router recovery: notices held during startup are sent now. */
  start(): void { const held = this.notices ?? []; this.notices = null; for (const send of held) send(); }
  private notify(text: string, key: string): void {
    const send = () => void this.router.send(service, { to: "person:owner", kind: "request", word: "say", body: { text, kind: "due" }, client_id: `devices:${key}` }).catch(() => {});
    if (this.notices) this.notices.push(send); else send();
  }
  /** A computer or browser asked to pair: the code it used is spent, and the owner hears about it wherever they are. */
  pairingRequested(request: { request_id: string; name: string; fingerprint: string }): void {
    if (this.code && !this.code.used_at && this.code.expires_at > Date.now()) this.code.used_at = Date.now();
    this.notify(`${label(request.name)} 想连上 Ash，指纹 ${label(request.fingerprint)}。是你的设备的话，去「设置 → 已连接设备」批准。`, `pair:${request.request_id}`);
  }
  /** For the local owner's screen only, outside the ledger. The revision changes whenever the page would show something new. */
  pairingView(): PairingView {
    const now = Date.now(), code = this.code;
    if (code && Math.max(code.used_at ?? 0, code.expires_at) < now - 10 * 60_000) this.code = null;
    const state = !this.code ? null : this.code.used_at ? "used" as const : this.code.expires_at <= now ? "expired" as const : "active" as const;
    const view: PairingView["code"] = !this.code || !state ? null : { state, kind: this.code.kind, gateway: this.code.gateway, expires_in_ms: Math.max(0, this.code.expires_at - now),
      ...(state === "active" ? { ticket: this.code.ticket, ...(this.code.kind === "browser" ? {} : { install_command: installCommand(this.code.gateway, this.code.ticket) }) } : {}) };
    const revision = createHash("sha256").update(JSON.stringify({ gateway: this.state(), code: view && { state: view.state, at: this.code!.issued_at } })).digest("hex").slice(0, 16);
    return { revision, code: view };
  }
  deviceName(id: string, fallback: string): string { return this.policies[id]?.name ?? fallback; }
  private save(): void { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, devices: this.policies }), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file); }
  private state(): Record<string, any> { return this.link()?.state() ?? { configured: false, connected: false, devices: [], pending: [] }; }
  private item(id: string): Record<string, any> | undefined { return this.state().devices?.find((d: any) => d.id === id); }
  private current(id: string): Policy | undefined {
    const device = this.item(id); if (!device) return undefined;
    return this.policies[id] ?? { name: device.name, kind: device.permissions?.includes("expose_capability") ? "laptop" : "browser", access: "approval", local_agents: false, web_ui: device.permissions?.includes("web_ui") ?? false, paired_at: 0 };
  }
  policy(id: string): "approval" | "full" | null { if (id === "device:phone") return null; const p = this.current(id); return p && p.kind !== "browser" ? p.access : null; }
  localAgentsAllowed(id: string): boolean { const p = this.current(id); return !!p && p.kind !== "browser" && p.local_agents && this.item(id)?.online === true; }
  needsApproval(word: string, body: Record<string, unknown>): boolean {
    if (["pair_approve", "update"].includes(word)) return true;
    if (word !== "access_set") return false;
    const previous = this.current(String(body.device));
    return (body.access === "full" && previous?.access !== "full") || (body.local_agents === true && !previous?.local_agents) || (body.web_ui === true && !previous?.web_ui);
  }
  approvalCard(request: Message): { title: string; detail: string } {
    const body = request.body;
    const pending = this.link()?.pending.get(String(body.request_id));
    const previous = this.current(String(body.device));
    const name = pending?.name ?? previous?.name ?? String(body.device ?? "设备");
    const access = body.access ?? previous?.access ?? "approval";
    const local = body.local_agents ?? previous?.local_agents ?? false;
    const web = body.web_ui ?? previous?.web_ui ?? body.kind === "browser";
    return { title: request.word === "update" ? `更新 ${name}` : `允许 ${name} 的设备权限？`, detail: request.word === "update"
      ? `安装版本 ${body.version}，校验值 ${body.sha256}。`
      : `${name}${pending ? ` · 指纹 ${pending.fingerprint}` : ""}\n类型：${body.kind ?? previous?.kind ?? "电脑"}。${body.kind === "browser" ? "仅聊天和网页界面，不借出电脑能力。" : "借出文件读写、命令及已安装的浏览器能力。"}\n操作档位：${access === "full" ? "完全放开（包括命令，不再逐次审批）" : "按规则和影响审批"}。\n本地 Agent：${local ? "允许，使用电脑本地完整权限" : "不允许"}；网页界面访问：${web ? "允许" : "不允许"}。` };
  }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    const fail = (code: "forbidden" | "not_found" | "offline" | "failed", text: string): ResponseBody => ({ ok: false, error: { code, message: text } });
    if (!context.caller?.local || context.caller.remote || !["person:owner", "agent:main"].includes(message.from) || context.caller.member !== message.from || context.signal.aborted) return fail("forbidden", "Device management requires the local owner or main agent");
    if (message.from !== "person:owner" && this.needsApproval(message.word, message.body) && this.router.ledger.gateCase(message.id)?.decision !== "allowed") return fail("forbidden", "Owner approval is required for this permission change");
    const b = message.body, link = this.link();
    if (message.word === "gateway_setup_guide") return { ok: true, result: { steps: ["部署项目中的网关并设置一次性认领密钥", "在 Ash 设置 → 已连接设备 → 网关，填写地址和认领密钥", "连接后使用 device_pair_start 配对电脑或浏览器"], automatic_deploy: false } };
    if (message.word === "list" || message.word === "gateway_status") return { ok: true, result: { ...this.state(), configured: !!link, devices: (this.state().devices ?? []).map((d: any) => ({ ...d, ...this.current(d.id) })) } };
    if (!link) return fail("offline", "Gateway is not configured");
    try {
      if (message.word === "pair_pending") return { ok: true, result: { pending: [...link.pending.values()] } };
      if (message.word === "pair_start") {
        // The code goes to the owner's screen only; whoever started pairing learns that it was issued, never its value.
        const issued = await link.ticket(), kind = String(b.kind ?? "laptop"), now = Date.now();
        this.code = { ticket: issued.ticket, gateway: issued.gateway, kind, issued_at: now, expires_at: now + issued.expires_in * 1000 };
        if (message.from !== "person:owner") this.notify(`Ash 生成了一个配对码，${Math.round(issued.expires_in / 60)} 分钟内有效。去「设置 → 已连接设备」查看，${kind === "browser" ? "在新浏览器里输入" : "在电脑上运行页面里的那一行命令"}。`, `code:${now}`);
        return { ok: true, result: { issued: true, kind, expires_in: issued.expires_in, gateway: issued.gateway, code_shown_to: "owner",
          instructions: "配对码只显示在主人手机的「设置 → 已连接设备」里，不会告诉你。请主人去那里查看并按提示连接新设备，再回来批准。" } };
      }
      if (message.word === "pair_reject") { await link.reject(String(b.request_id)); return { ok: true, result: { rejected: true } }; }
      if (message.word === "pair_approve") {
        const request = link.pending.get(String(b.request_id)); if (!request) return fail("not_found", "Pairing request expired or missing");
        const browser = b.kind === "browser";
        if (browser && (b.local_agents === true || b.access === "full")) return fail("forbidden", "Browser pairing cannot grant local agents or full device access");
        const id = `device:${request.client_id}`, web = browser || b.web_ui === true;
        // Persist a restrictive default before changing the gateway grant; full access is saved only after success.
        this.policies[id] = { name: request.name, kind: b.kind as Policy["kind"], access: "approval", local_agents: false, web_ui: web, paired_at: Date.now() }; this.save();
        await link.approve(request.request_id, browser ? ["chat", "web_ui"] : ["expose_capability", ...(web ? ["chat", "web_ui"] as const : [])]);
        this.policies[id] = { ...this.policies[id], access: b.access === "full" ? "full" : "approval", local_agents: !browser && b.local_agents === true }; this.save();
        await link.refreshDevices(); return { ok: true, result: { approved: true, device: id } };
      }
      const id = String(b.device), previous = this.current(id); if (!previous) return fail("not_found", "Unknown or revoked device");
      if (message.word === "describe" || message.word === "diagnose") return { ok: true, result: { ...this.item(id), ...previous, gateway_connected: link.connected, gateway_error: link.lastError || undefined,
        recent_calls: this.router.ledger.list({ limit: 1000 }).filter(m => m.to === id && m.kind === "request").slice(-10).reverse().map(m => {
          const reply = this.router.ledger.responseTo(m.id)?.body as ResponseBody | undefined;
          return { id: m.id, at: m.ts, from: m.from, word: m.word, status: reply ? reply.ok ? "ok" : reply.error.code : "pending" };
        }) } };
      if (message.word === "revoke") { await link.revoke(id); link.closeAgentChannel(id); delete this.policies[id]; this.save(); await link.refreshDevices(); return { ok: true, result: { revoked: true } }; }
      if (message.word === "rename") {
        const name = String(b.name).trim(); if (!name) return fail("failed", "Device name cannot be blank");
        this.policies[id] = { ...previous, name }; this.save(); await link.refreshDevices();
        return { ok: true, result: { device: id, name } };
      }
      if (message.word === "access_set") {
        if (previous.kind === "browser" && (b.local_agents === true || b.access === "full")) return fail("forbidden", "Browser cannot host local agents or grant full device access");
        const next = { ...previous, ...(b.access !== undefined ? { access: b.access as Policy["access"] } : {}), ...(b.local_agents !== undefined ? { local_agents: b.local_agents === true } : {}), ...(b.web_ui !== undefined ? { web_ui: b.web_ui === true } : {}) };
        if (next.web_ui !== previous.web_ui) await link.setWebUi(id, next.web_ui);
        this.policies[id] = next; this.save();
        if (!next.local_agents) link.closeAgentChannel(id);
        return { ok: true, result: { device: id, ...next } };
      }
      if (message.word === "update") {
        if (!link.updateDevice) return fail("failed", "Device updater is unavailable");
        return { ok: true, result: await link.updateDevice(id, String(b.version), String(b.sha256)) };
      }
      return fail("not_found", "Unknown device operation");
    } catch { return fail("failed", "Device operation failed; refresh status before retrying"); }
  }
}

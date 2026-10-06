import type { AskOption, CallResult, JsonSchema, SendRequestV2, WordEffect } from "./api";

export interface HostCapabilityV2 {
  name: string;
  description: string;
  input_schema: JsonSchema;
  risk: "none" | "outward" | "structure";
  effect?: WordEffect;
  label: string;
  confirm?: boolean;
}
export interface HostManifestV2 { name: string; capabilities: HostCapabilityV2[] }
export interface HostCallV2 { capability: string; args: Record<string, unknown>; caller: string }
export type HostCallResultV2 = CallResult;
interface HostPresentationBaseV2 {
  id: string;
  title: string;
  text: string;
  expires_at?: number;
  reply_to?: string;
}
/** How a reply notification reaches the owner: "quiet" while its task is still running, "strong" for a finished task's result. */
export type HostAlertV2 = "quiet" | "strong";
export type HostPresentationV2 =
  | (HostPresentationBaseV2 & { kind: "reply"; alert?: HostAlertV2; options?: never; reply_target?: never })
  | (HostPresentationBaseV2 & { kind: "due" | "offer" | "heads_up"; options?: never; reply_target?: never })
  | (HostPresentationBaseV2 & { kind: "approval"; options: AskOption[]; expires_at: number; reply_to: string; reply_target: string })
  | (HostPresentationBaseV2 & { kind: "approval"; human_kind: "question"; allow_custom?: boolean; options: { id: string; label: string }[]; expires_at: number; reply_to: string; reply_target: string });
export interface HostHideV2 { id: string }
export type HostSenseV2 = SendRequestV2 & { to: null; kind: "event"; word: `sense.${string}` };
export type HostAskAnswerV2 = SendRequestV2 & { kind: "response"; word: "ask"; reply_to: string; body: { ok: true; result: { choice: "once" | "always" | "deny" } } };
export type HostNotificationReplyV2 = SendRequestV2 & { to: "agent:main"; kind: "request"; word: "say"; body: { text: string } };

/** Host and fake-host use the same fail-closed C7 envelope check before presentation. */
export function hostPresentationErrors(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["presentation must be an object"];
  const item = value as Record<string, unknown>;
  const allowed = new Set(["id", "kind", "title", "text", "options", "expires_at", "reply_to", "reply_target", "human_kind", "allow_custom", "alert"]);
  const errors: string[] = [];
  for (const key of Object.keys(item)) if (!allowed.has(key)) errors.push(`unsupported field: ${key}`);
  if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 128) errors.push("invalid id");
  if (typeof item.title !== "string" || typeof item.text !== "string") errors.push("title and text must be strings");
  if (!["reply", "approval", "due", "offer", "heads_up"].includes(String(item.kind))) errors.push("invalid kind");
  if (item.expires_at !== undefined && (!Number.isSafeInteger(item.expires_at) || Number(item.expires_at) <= 0)) errors.push("invalid expiry");
  if (item.reply_to !== undefined && (typeof item.reply_to !== "string" || !item.reply_to.trim())) errors.push("invalid reply_to");
  if (item.alert !== undefined && (item.kind !== "reply" || !["quiet", "strong"].includes(String(item.alert)))) errors.push("alert is quiet or strong, for replies only");
  if (item.kind === "approval") {
    const question = item.human_kind === "question";
    if (item.human_kind !== undefined && !question || item.allow_custom !== undefined && (!question || typeof item.allow_custom !== "boolean")) errors.push("invalid question metadata");
    if (typeof item.reply_to !== "string" || !item.reply_to.trim()) errors.push("approval needs reply_to");
    if (typeof item.reply_target !== "string" || !/^(?:person|screen|agent|device|service|worker):[A-Za-z0-9_.-]+$/.test(item.reply_target)) errors.push("approval needs member reply_target");
    if (!Number.isSafeInteger(item.expires_at) || Number(item.expires_at) <= 0) errors.push("approval needs expires_at");
    if (!Array.isArray(item.options) || item.options.length === 0) errors.push("approval needs options");
    else {
      const seen = new Set<string>();
      for (const option of item.options) {
        if (!option || typeof option !== "object" || Array.isArray(option) ||
            !(question ? typeof (option as { id?: unknown }).id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test((option as { id: string }).id) : ["once", "always", "deny"].includes((option as { id?: string }).id ?? "")) ||
            typeof (option as { label?: unknown }).label !== "string" || !(option as { label: string }).label.trim() ||
            Object.keys(option).some((key) => key !== "id" && key !== "label")) { errors.push("invalid option"); continue; }
        const id = (option as { id: string }).id;
        if (seen.has(id)) errors.push("duplicate option");
        seen.add(id);
      }
      if (!question && !seen.has("deny")) errors.push("approval notification needs deny option");
      if (question && seen.size > 8) errors.push("too many question options");
    }
  } else if (item.options !== undefined || item.reply_target !== undefined || item.human_kind !== undefined || item.allow_custom !== undefined) errors.push("reply routing is only for approval");
  return errors;
}

export const HOST_ROUTES_V2 = {
  manifest: "GET /manifest",
  call: "POST /call",
  present: "POST /present",
  hide: "POST /present/hide",
  alert: "POST /present/alert",
  alarm: "POST /alarm",
  key: "GET /key",
  sign: "POST /sign",
  restart: "POST /restart",
  decisionSurface: "POST /decision/surface",
  decisionScreen: "POST /decision/screen",
  decisionReturn: "POST /decision/return",
  decisionVirtualClose: "POST /decision/virtual-close",
} as const;

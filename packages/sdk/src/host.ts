import type { AskOption, CallResult, JsonSchema, SendRequestV2 } from "./api";

export interface HostCapabilityV2 {
  name: string;
  description: string;
  input_schema: JsonSchema;
  risk: "none" | "outward" | "structure";
  label: string;
  confirm?: boolean;
}
export interface HostManifestV2 { name: string; capabilities: HostCapabilityV2[] }
export interface HostCallV2 { capability: string; args: Record<string, unknown>; caller: string }
export type HostCallResultV2 = CallResult;
export interface HostPresentationV2 {
  id: string;
  kind: "reply" | "approval" | "due" | "offer" | "heads_up";
  title: string;
  text: string;
  options?: AskOption[];
  expires_at?: number;
  reply_to?: string;
}
export interface HostHideV2 { id: string }
export type HostSenseV2 = SendRequestV2 & { to: null; kind: "event"; word: `sense.${string}` };
export type HostAskAnswerV2 = SendRequestV2 & { kind: "response"; word: "ask"; reply_to: string; body: { ok: true; result: { choice: "once" | "always" | "deny" } } };
export type HostNotificationReplyV2 = SendRequestV2 & { to: "agent:main"; kind: "request"; word: "say"; body: { text: string } };

export const HOST_ROUTES_V2 = {
  manifest: "GET /manifest",
  call: "POST /call",
  present: "POST /present",
  hide: "POST /present/hide",
  alarm: "POST /alarm",
  key: "GET /key",
  sign: "POST /sign",
  restart: "POST /restart",
} as const;

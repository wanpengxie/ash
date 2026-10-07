import type { WordSpec, JsonSchema } from "./api";
const string: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };
const bool: JsonSchema = { type: "boolean" };
const device: JsonSchema = { type: "string", pattern: "^device:[A-Za-z0-9_-]+$" };
const access: JsonSchema = { type: "string", enum: ["approval", "full"] };
const kind: JsonSchema = { type: "string", enum: ["laptop", "server", "browser"] };
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const accessFields = { access, local_agents: bool, web_ui: bool };
const specs: [string, string, JsonSchema, boolean?][] = [
  ["list", "列出已连接设备", object({})],
  ["describe", "查看设备详情", object({ device }, ["device"])],
  ["pair_start", "开始设备配对", object({ kind })],
  ["pair_pending", "查看配对申请", object({})],
  ["pair_approve", "批准设备配对", object({ request_id: string, kind, ...accessFields }, ["request_id", "kind"]), true],
  ["pair_reject", "拒绝设备配对", object({ request_id: string }, ["request_id"]), true],
  ["revoke", "断开并撤销设备", object({ device }, ["device"]), true],
  ["rename", "修改设备名称", object({ device, name: string }, ["device", "name"]), true],
  ["access_set", "调整设备权限", object({ device, ...accessFields }, ["device"]), true],
  ["diagnose", "诊断设备连接", object({ device }, ["device"])],
  ["update", "更新设备程序", object({ device, version: { type: "string", pattern: "^v?[0-9]+\\.[0-9]+\\.[0-9]+$" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["device", "version", "sha256"]), true],
  ["gateway_status", "查看网关状态", object({})],
  ["gateway_setup_guide", "查看网关设置指引", object({})],
];
export const DEVICE_WORDS: readonly (WordSpec & { input_schema: JsonSchema })[] = specs.map(([word, label, input_schema, mutation]) => ({
  word, kind: "request", input_schema, result_schema: { type: "object", additionalProperties: true },
  description: `${label}。配对批准、扩大权限和更新需要主人确认；批准后须重新核对并兑换审批，不自动执行。`,
  label, audience: "all", risk: mutation ? "structure" : "none", effect: mutation ? "structure" : "read",
}));
export const deviceToolName = (word: string): string => word.startsWith("gateway_") ? word : `device_${word}`;

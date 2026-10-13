import { currentNativeInvocationClaim } from "../collaboration/delivery";
import { currentPreparedMaterialInput } from "../collaboration/material-input-reader";
import { identity, keys } from "./protocol";
import type { RegistryPort, RoleLease, WorkGrant } from "./types";
export const METHOD_POLICY = new Map<string, string>([
  ["initialize", "initialize"], ["thread/read", "read"], ["thread/resume", "resume"], ["thread/turns/list", "read"],
  ["turn/start", "send_input"], ["turn/steer", "steer"], ["thread/start", "create"], ["thread/name/set", "name"], ["project/list", "project"],
  ["model/list", "gui-read"], ["mcpServerStatus/list", "gui-read"],
  ...["mcpServer/tool/call", "mcpServer/resource/read", "mcpServer/event/stream/start", "mcpServer/event/stream/stop"].map(m => [m, "mcp-direct"] as [string,string]),
]);
function textInput(v: unknown): void {
  if (!Array.isArray(v) || v.length !== 1) throw Error("input denied"); const x = v[0]; keys(x, ["type", "text", "text_elements"]);
  if (x.type !== "text" || typeof x.text !== "string" || !x.text.trim() || Buffer.byteLength(x.text) > 64 * 1024 || !Array.isArray(x.text_elements) || x.text_elements.length) throw Error("input denied");
}
export function authorize(method: string, p: any, lease: RoleLease, registry: RegistryPort, known: ReadonlySet<string>): WorkGrant | undefined {
  const policy = METHOD_POLICY.get(method); if (!known.has(method) || !policy) throw Error("method denied");
  if (policy === "initialize") { keys(p, ["clientInfo", "capabilities"]); keys(p.clientInfo, ["name", "version", "title"]); if (!identity(p.clientInfo.name) || !identity(p.clientInfo.version)) throw Error("initialize denied"); keys(p.capabilities, ["experimentalApi", "optOutNotificationMethods"]); if (p.capabilities.experimentalApi !== true || p.capabilities.optOutNotificationMethods !== undefined) throw Error("capabilities denied"); return; }
  if (policy === "mcp-direct") { if (lease.role !== "gui" || registry.resolve(p?.server) !== "nonprotected") throw Error("MCP direct denied"); if (!identity(p.threadId) || !lease.works.has(p.threadId)) throw Error("work denied"); return lease.works.get(p.threadId); }
  if (policy === "gui-read") { if (lease.role !== "gui") throw Error("role denied"); keys(p, ["cursor", "limit"]); page(p); return; }
  if (!registry.current()) throw Error("registry unavailable");
  if (policy === "project") { if (!lease.create) throw Error("create scope denied"); keys(p, ["cursor", "limit"]); page(p); return; }
  if (policy === "create") { keys(p, ["cwd", "projectId", "ephemeral"]); if (!lease.create || p.cwd !== lease.create.cwd || p.projectId !== lease.create.projectId || p.ephemeral !== false) throw Error("create scope denied"); return; }
  if (!identity(p?.threadId)) throw Error("work denied"); const grant = lease.works.get(p.threadId); if (!grant || grant.work.native_id !== p.threadId || grant.work.kind !== "conversation" || !identity(grant.work.node_id) || !identity(grant.work.endpoint_id) || !grant.actions.has(policy as any)) throw Error("action denied");
  if (method === "thread/read") { keys(p, ["threadId", "includeTurns"]); if (p.includeTurns !== false) throw Error("history hydration denied"); }
  if (method === "thread/resume") { keys(p, ["threadId", "excludeTurns"]); if (p.excludeTurns !== true) throw Error("resume hydration denied"); }
  if (method === "thread/turns/list") { keys(p, ["threadId", "limit", "cursor", "sortDirection", "itemsView"]); page(p); if (p.sortDirection !== "desc" || !["summary", "full"].includes(p.itemsView)) throw Error("history denied"); }
  if (["turn/start", "turn/steer"].includes(method)) { keys(p, ["threadId", "input", "clientUserMessageId", ...(method === "turn/steer" ? ["expectedTurnId"] : [])]); if(grant.preparedInput){if(lease.role!=='device')throw Error('material role denied');const prepared=currentPreparedMaterialInput(grant.preparedInput),i=prepared.invocation;if(i.request.work.native_id!==p.threadId||i.request.action!==(method==='turn/steer'?'steer':'send_input')||i.native_client_message_id!==p.clientUserMessageId||JSON.stringify(p.input)!==JSON.stringify(prepared.inputs)||i.request.expected_turn_id!==p.expectedTurnId)throw Error('material invocation denied');}else if(grant.claimInput){if(lease.role!=='device')throw Error('claim role denied');const i=currentNativeInvocationClaim(grant.claimInput);if(i.request.input.material||i.request.work.native_id!==p.threadId||i.request.action!==(method==='turn/steer'?'steer':'send_input')||i.native_client_message_id!==p.clientUserMessageId||i.request.expected_turn_id!==p.expectedTurnId||JSON.stringify(p.input)!==JSON.stringify([{type:'text',text:i.request.input.text,text_elements:[]}]))throw Error('text claim denied');textInput(p.input);}else textInput(p.input); if (!identity(p.clientUserMessageId)) throw Error("client message denied"); if (method === "turn/steer" && (!identity(p.expectedTurnId) || p.expectedTurnId !== grant.expectedTurnId)) throw Error("active turn denied"); }
  if (method === "thread/name/set") { keys(p, ["threadId", "name"]); if (!lease.create || grant.createOperationId !== lease.create.operationId || typeof p.name !== "string" || !p.name.trim() || Buffer.byteLength(p.name) > 256) throw Error("create name denied"); }
  return grant;
}
function page(p: any): void { if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 25 || (p.cursor !== undefined && !identity(p.cursor))) throw Error("page denied"); }

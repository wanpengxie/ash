import { mkdtemp, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { ProtectedRegistry } from "../../src/host-proxy/protected-registry";
import { PrivateRoleListeners } from "../../src/host-proxy/role-listener";
import { HostProxy } from "../../src/host-proxy/proxy";
import { METHOD_POLICY } from "../../src/host-proxy/method-policy";
import type { Frame, RoleLease, WorkGrant } from "../../src/host-proxy/types";
export const version = "0.162.0-alpha.17.2";
export const work = { node_id: "node", endpoint_id: "endpoint", kind: "conversation" as const, native_id: "thread" };
export async function connect(url: string, token?: string): Promise<WebSocket> { return new Promise((r, j) => { const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }); ws.once("open", () => r(ws)); ws.once("error", j); }); }
export async function fixture(options: { maxRetired?: number; delay?: Promise<void>; wrongCredential?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hp-"))); await chmod(directory, 0o700); const path = join(directory, "registry.json");
  const manifest = { version, connectors: [{ canonical: "ash", aliases: ["ash-material", "material/probe"], protected: true }, { canonical: "ordinary", aliases: [], protected: false }] };
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 }); const registry = new ProtectedRegistry(path, version, () => true);
  const credential = randomUUID(); const native = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (info: { req: import("node:http").IncomingMessage }) => info.req.headers.authorization === `Bearer ${credential}` });
  await new Promise(r => native.once("listening", r)); const address = native.address() as { port: number }; const url = `ws://127.0.0.1:${address.port}`;
  const calls: Frame[] = []; const peers: WebSocket[] = []; let status: any = { type: "idle" }; let roleEpoch = 1; let nativeEpoch = "native-one"; let held: Frame | undefined;
  let grants = new Map<string, WorkGrant>([["thread", { work, threadId: "thread", actions: new Set(["read", "resume", "send_input", "steer"]), expectedTurnId: "turn" }]]);
  native.on("connection", ws => { peers.push(ws); ws.on("message", bytes => { const v = JSON.parse(String(bytes)); calls.push(v); if (v.id === undefined || !v.method) return; if (v.method === "mcpServer/tool/call") { held = v; }
    const result = v.method === "initialize" ? { userAgent: `codex ${version}` } : v.method === "thread/turns/list" ? { data: v.params.itemsView === "summary" ? [{ id: "turn", status: "inProgress" }] : [], nextCursor: null } : v.method === "turn/steer" ? { turnId: "turn" } : v.method === "turn/start" ? { turn: { id: "turn" } } : v.method === "project/list" ? { data: [{ id: "project", roots: [{ path: "/project" }, { path: "/foreign" }] }, { id: "foreign", roots: [{ path: "/foreign" }] }], nextCursor: null } : v.method === "thread/start" ? { thread: { id: "created", cwd: "/project", projectId: "project" } } : v.method === "thread/name/set" ? {} : { thread: { id: v.params.threadId, cwd: "/project", status } };
    ws.send(JSON.stringify({ id: v.id, result })); }); });
  const proxy = new HostProxy({ version, registry, listeners: new PrivateRoleListeners(directory), clientMethods: new Set(METHOD_POLICY.keys()), serverMethods: new Set(["item/tool/call", "item/commandExecution/requestApproval"]), maxRetired: options.maxRetired, timeoutMs: 1000,
    native: { identity: () => ({ identity: "verified-fixture", generation: nativeEpoch, version }), current: i => i.generation === nativeEpoch, connect: async () => { if (options.delay) await options.delay; return connect(url, options.wrongCredential ? "wrong" : credential); } },
    roles: { acquire: (role, identity): RoleLease => ({ role, identity, epoch: roleEpoch, generation: "fixture", works: grants, create: { operationId: "create-op", cwd: "/project", projectId: "project" } }), current: l => l.epoch === roleEpoch, epoch: () => roleEpoch,
      registerCreated: (lease, grant, thread) => { grants = new Map(grants); grants.set(thread.id, { work: { ...work, native_id: thread.id }, threadId: thread.id, actions: new Set(["read", "send_input", "name"]), createOperationId: grant.operationId }); roleEpoch++; return { ...lease, epoch: roleEpoch, works: grants }; } } });
  await proxy.start();
  const client = (role: "gui" | "device") => connect(`ws+unix://localhost${join(directory, `${role}.sock`)}:/rpc`);
  return { directory, path, registry, manifest, proxy, calls, peers, client, credential, url, get grants() { return grants; }, setStatus: (s: any) => { status = s; }, revoke: () => { roleEpoch++; }, advanceNative: () => { nativeEpoch = "native-two"; }, get held() { return held; }, close: async () => { await proxy.close(); native.clients.forEach(ws => ws.terminate()); await new Promise<void>(r => native.close(() => r())); await rm(directory, { recursive: true, force: true }); } };
}
export function request(ws: WebSocket, frame: Frame): Promise<Frame> { return new Promise((r, j) => { const timer = setTimeout(() => { cleanup(); j(Error("fixture timeout")); }, 1500); function cleanup() { clearTimeout(timer); ws.off("message", message); ws.off("close", close); } function message(b: any) { const v = JSON.parse(String(b)); if (v.id === frame.id) { cleanup(); r(v); } } function close() { cleanup(); j(Error("closed")); } ws.on("message", message); ws.on("close", close); ws.send(JSON.stringify(frame)); }); }
export async function initialize(ws: WebSocket) { await request(ws, { id: 1, method: "initialize", params: { clientInfo: { name: "fixture", version: "1" }, capabilities: { experimentalApi: true } } }); ws.send(JSON.stringify({ method: "initialized" })); }

import { EventEmitter } from "node:events";
import { CodexCreateTransport } from "../../src/collaboration/codex-create-transport";
import { CodexCreateAdapter } from "../../src/collaboration/codex-create";
import type { CreateInvocation } from "../../src/collaboration/create-types";
export class FakeCreateSocket extends EventEmitter {
  calls: any[] = [];
  projects: any = { data: [{ id: "project", roots: [{ path: "/project" }] }], nextCursor: null };
  history: any = { data: [], nextCursor: null };
  cwd = "/project";
  hook?: (call: any) => void;
  fault?: string;
  send(data: string): void {
    const call = JSON.parse(data); this.calls.push(call); this.hook?.(call);
    if (!call.id) return;
    if (call.method === this.fault) return;
    const result = call.method === "initialize" ? { userAgent: "codex 1.2.3" } : call.method === "project/list" ? this.projects : call.method === "thread/name/set" ? {} : call.method === "turn/start" ? { turn: { id: "turn" } } : call.method === "thread/turns/list" ? this.history : { thread: { id: "thread", cwd: this.cwd, projectId: "project" } };
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: call.id, result }))));
  }
  close(): void {}
}
export async function createSocketFixture(timeoutMs = 200) {
  const socket = new FakeCreateSocket(); let valid = true, allowed = true;
  const transport = new CodexCreateTransport({ socket: "/fake.sock", executable: "/fake/codex", pid: 123, supportedVersions: ["1.2.3"], timeoutMs,
    verifyListener: () => ({ socket: "/fake.sock", executable: "/fake/codex", pid: 123, version: "1.2.3", identity: valid ? "one" : "two" }), connectSocket: async () => socket });
  const adapter = new CodexCreateAdapter({ node_id: "node", endpoint_id: "endpoint", transport }); await adapter.connect();
  const invocation = (): CreateInvocation => ({ principal: { principal_id: "owner" }, request: { version: 1, request_id: "request", operation_id: "operation", authorization_revision: "a".repeat(64), target: { node_id: "node", endpoint_id: "endpoint", project_id: "project", cwd: "/project" }, title: "Title", input: { text: "first" }, expires_at: Date.now() + 5000 }, attempt_id: "persisted-attempt", connector_epoch: adapter.connector_epoch, native_interface_version: adapter.native_interface_version, authorized_scope: { node_id: "node", endpoint_id: "endpoint", cwd: "/project" }, deadline: Date.now() + 5000, authorize: async () => allowed });
  return { socket, transport, adapter, invocation, revoke: () => { allowed = false; }, invalidate: () => { valid = false; } };
}

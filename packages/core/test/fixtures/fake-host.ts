import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { hostPresentationErrors } from "../../../sdk/src/host";

export type HostRecord = { method: string; path: string; body: unknown };
export type Capability = { name: string; description: string; input_schema: Record<string, unknown>; risk: "none" | "outward" | "structure"; label: string; confirm?: boolean };
export type HostScript = { capability: string; result: unknown };

export class FakeHost {
  readonly calls: HostRecord[] = [];
  readonly scripts: HostScript[] = [];
  manifest: { name: string; capabilities: Capability[] } = { name: "Test phone", capabilities: [] };
  keyResponse: unknown = { id: "test-device", publicKey: "test-public-key" };
  signResponse: unknown = { sig: "test-signature" };
  private server?: Server;
  url = "";
  constructor(readonly token = "test-host-token") {}

  queueCall(capability: string, result: unknown) { this.scripts.push({ capability, result }); }
  async start(): Promise<string> {
    assert.ok(!this.server, "host already running");
    this.server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return; }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { res.writeHead(400).end(JSON.stringify({ error: "bad_json" })); return; }
      this.calls.push({ method: req.method ?? "", path, body });
      const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
      if (req.method === "GET" && path === "/manifest") return json(200, this.manifest);
      if (req.method === "GET" && path === "/key") return json(200, this.keyResponse);
      if (req.method === "POST" && path === "/call") {
        const call = body as { capability?: string } | undefined;
        const next = this.scripts.shift();
        if (!next || next.capability !== call?.capability) return json(409, { error: "unexpected_call", expected: next?.capability, got: call?.capability });
        return json(200, next.result);
      }
      if (req.method === "POST" && path === "/present") {
        const errors = hostPresentationErrors(body);
        return errors.length ? json(400, { error: "bad_presentation", details: errors }) : json(200, { ok: true });
      }
      if (req.method === "POST" && ["/present/hide", "/alarm"].includes(path)) return json(200, { ok: true });
      if (req.method === "POST" && path === "/sign") return json(200, this.signResponse);
      if (req.method === "POST" && path === "/restart") return json(200, { ok: true });
      return json(404, { error: "not_found" });
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.url;
  }
  assertCall(path: string, body?: unknown) {
    const hit = this.calls.find(c => c.path === path && (body === undefined || JSON.stringify(c.body) === JSON.stringify(body)));
    assert.ok(hit, `expected host call ${path} ${JSON.stringify(body)}`);
    return hit;
  }
  assertDrained() { assert.equal(this.scripts.length, 0, "unconsumed host call scripts"); }
  async close() { if (this.server) { await new Promise<void>((resolve, reject) => this.server!.close(e => e ? reject(e) : resolve())); this.server = undefined; } }
}

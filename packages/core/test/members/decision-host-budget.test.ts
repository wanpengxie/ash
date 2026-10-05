import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HostDeviceLink } from "../../src/host-v2";
import { wordContract } from "../../../sdk/src/words";

test("decision RPC budgets cover native settling/acknowledgment and still honor cancellation", async () => {
  const host = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/manifest") { res.end(JSON.stringify({ name: "Test phone", capabilities: [] })); return; }
    // Longer than the old 800/900ms deadlines, shorter than the native+transport budget.
    setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ ok: true })); }, 1100);
  });
  await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
  const link = await HostDeviceLink.probe({ url: `http://127.0.0.1:${(host.address() as { port: number }).port}`, token: "synthetic" });
  try {
    for (const word of ["surface.get", "screen.get", "screen.return"]) {
      assert.deepEqual(await link.decisionCall(word, {}, new AbortController().signal), { ok: true });
      assert.ok(wordContract("service:reflex", word)!.timeout_ms! >= (word === "surface.get" ? 2000 : 3000));
    }
    await assert.rejects(link.decisionCall("screen.get", {}, AbortSignal.abort(new Error("new owner turn"))), /new owner turn/);
  } finally { link.close(); host.closeAllConnections(); await new Promise<void>((r) => host.close(() => r())); }
});

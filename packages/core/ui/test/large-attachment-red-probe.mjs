// Run before the bounded summary-stream contract lands; RED is an expected blocker.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/world/ledger.ts";
import { WorldRouter } from "../../src/world/router.ts";
import { WorldMembers } from "../../src/world/member.ts";
import { EdgeRouter, startEdgeServer } from "../../src/server.ts";
import { wordContract } from "../../../sdk/src/words.ts";
import { readSse } from "../js/net.js";

const root = mkdtempSync(join(tmpdir(), "ash-attachment-red-"));
const ledger = await Ledger.open(join(root, "ledger.db"));
const world = new WorldRouter(ledger, async () => true);
const members = new WorldMembers(world);
members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "say")], handle: () => ({ ok: true, result: { accepted: true } }) });
const edge = new EdgeRouter(ledger, world, members, { api: { "synthetic-owner": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
let server;
try {
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: "Bearer synthetic-owner" };
  const observations = [];
  for (const mib of [2, 19]) {
    const bytes = Buffer.alloc(mib * 1024 * 1024, 65);
    const sent = await fetch(`${base}/api/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [{ name: `synthetic-${mib}.bin`, mime_type: "application/octet-stream", data: bytes.toString("base64") }] }, client_id: `large-${mib}` }) });
    assert.equal(sent.status, 200);
    const accepted = await sent.json();
    assert.equal(ledger.byId(accepted.id)?.body.attachments?.[0]?.data.length, bytes.toString("base64").length);
    const response = await fetch(`${base}/api/stream?before=${accepted.seq + 1}&limit=1&follow=false`, { headers: auth });
    let observed = "readable";
    try { await readSse(response, () => {}); }
    catch (error) { observed = error.message; }
    observations.push({ mib, observed });
  }
  console.log(JSON.stringify({ result: "RED", observations }));
  assert.deepEqual(observations.map((item) => item.observed), ["stream frame too large", "stream frame too large"]);
} finally {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  ledger.close();
  rmSync(root, { recursive: true, force: true });
}

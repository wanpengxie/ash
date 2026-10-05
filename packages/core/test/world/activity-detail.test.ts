import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { EdgeRouter, type EdgeCaller } from "../../src/server";
test("activity detail is owner-only, paginated without losing command tail, and redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-activity-detail-"));
  const ledger = await Ledger.open(join(dir, "ledger.db")); const router = new WorldRouter(ledger, () => true);
  const edge = new EdgeRouter(ledger, router, new WorldMembers(router), { api: {}, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
  const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "owner", transport: "api", ownerProxy: true, local: true, remote: false };
  try {
    const request = router.recordDshToolCall("t_detail", "long", "bash", JSON.stringify({ command: "echo line\n".repeat(3000) + "END_OF_COMMAND", api_key: "PRIVATE_KEY" }));
    router.recordDshToolResult(request.id, true, "END_OF_RESULT");
    const get = (offset: number, caller: EdgeCaller | null = owner) => edge.handle({ method: "GET", url: new URL(`http://local/api/activity/detail?id=${request.id}&offset=${offset}`), headers: {}, body: null }, caller);
    assert.equal((await get(0, null)).status, 401);
    assert.equal((await get(0, { ...owner, member: "agent:main", ownerProxy: false })).status, 403);
    assert.equal((await get(-1)).status, 400);
    let offset: number | null = 0, all = "";
    do { const response = await get(offset); assert.equal(response.status, 200); const page = JSON.parse(String("body" in response ? response.body : "")); all += page.text; offset = page.next_offset; } while (offset !== null);
    assert.match(all, /END_OF_COMMAND/); assert.match(all, /END_OF_RESULT/); assert.doesNotMatch(all, /PRIVATE_KEY/);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

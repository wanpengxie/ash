import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

test("one option card accepts exactly one matching owner say across two screens; same retry is stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-options-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "say")!], handle: () => ({ ok: true, result: { accepted: true } }) });
  const card = ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "show",
    body: { card: { type: "options", options: [{ id: "yes", text: "好" }, { id: "no", text: "不要" }] } } }).message;
  const screen = (name: string): TrustedRouteContext => ({ member: "person:owner", transport: "api", transportPrincipal: name,
    local: true, remote: false, ownerProxy: true });
  const say = (option_id: string, text: string, client_id: string) => ({ to: "agent:main", kind: "request" as const,
    word: "say", body: { text, in_reply_to: card.id, option_id }, client_id, wait: true });
  try {
    await assert.rejects(router.send(screen("a"), say("yes", "不匹配", "bad")), (error: unknown) => error instanceof RouterError && error.code === "bad_request");
    const [first, second] = await Promise.allSettled([
      router.send(screen("a"), say("yes", "好", "a")), router.send(screen("b"), say("no", "不要", "b")),
    ]);
    assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
    const winner = first.status === "fulfilled" ? first.value : (second as PromiseFulfilledResult<Awaited<ReturnType<typeof router.send>>>).value;
    const source = first.status === "fulfilled" ? "a" : "b";
    const request = first.status === "fulfilled" ? say("yes", "好", "a") : say("no", "不要", "b");
    assert.equal(winner.reply?.body.ok, true);
    assert.equal((await router.send(screen(source), request)).id, winner.id);
    assert.equal(ledger.list({ limit: 100 }).filter((item) => item.from === "person:owner" && item.word === "say").length, 1);
    assert.equal(ledger.list({ limit: 100 }).filter((item) => item.from === "person:owner" && item.word === "say")[0].body.in_reply_to, card.id);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

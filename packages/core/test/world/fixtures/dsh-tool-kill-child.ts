import { join } from "node:path";
import { startOwner } from "../../../src/main";

const root = process.env.TEST_ROOT!;
const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home: join(root, "home") }, listen: "127.0.0.1:0",
  agents: [{ id: "agent:main", runtime: "dsh" }], host: { url: process.env.TEST_HOST_URL!, token: "synthetic-host-token" },
  dsh: { root: process.env.ASH_TEST_DSH_ROOT!, home: join(root, "dsh"), env: {
    DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: process.env.TEST_MODEL_URL!,
  } } });

if (process.env.TEST_PHASE === "first") {
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
  const sent = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "call synthetic device once" }, client_id: "tool-kill-1" }) });
  process.send?.({ type: "accepted", status: sent.status });
  await new Promise(() => {});
} else {
  const rows = running.ledger.list({ after: 0, limit: 1000 });
  const hold = rows.find((message) => message.kind === "request" && message.to === "device:phone" && message.word === "hold");
  const reply = hold ? running.ledger.responseTo(hold.id) : null;
  const sessionId = (JSON.parse((await import("node:fs")).readFileSync(join(root, "state", "dsh-main-session.json"), "utf8")) as { id: string }).id;
  const reader = await running.dsh!.ctx.get("sessionPersistence").open(sessionId, "read");
  const events = (await reader.read()).events as { type: string; data?: Record<string, unknown> }[];
  await reader.close();
  process.send?.({ type: "recovered", holdCount: rows.filter((message) => message.kind === "request" && message.word === "hold").length,
    replyCount: rows.filter((message) => message.kind === "response" && message.reply_to === hold?.id).length,
    replyCode: (reply?.body.error as { code?: string } | undefined)?.code,
    turnReasons: rows.filter((message) => message.word === "turn.end").map((message) => message.body.reason),
    dshUnknownToolResults: events.filter((event) => event.type === "tool/result" && JSON.stringify(event.data).includes("unknown")).length });
  await running.close();
  process.exit(0);
}

import { join } from "node:path";
import { startOwner } from "../../../src/main";

const root = process.env.TEST_ROOT!;
const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home: join(root, "home") }, listen: "127.0.0.1:0",
  agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: process.env.ASH_TEST_DSH_ROOT!, home: join(root, "dsh"), env: {
    DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: process.env.TEST_MODEL_URL!,
  } } });
if (process.env.TEST_PHASE === "first") {
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
  const result = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "kill-window synthetic" }, client_id: "kill-window-1" }) });
  process.send?.({ type: "accepted", status: result.status });
} else {
  process.send?.({ type: "recovered", turns: running.ledger.list().filter((message) => message.word === "turn.end").map((message) => message.body.reason),
    replies: running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.kind === "request" && message.word === "say").map((message) => message.body.text) });
  await running.close();
  process.exit(0);
}
await new Promise(() => {});

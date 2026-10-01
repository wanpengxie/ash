import { join } from "node:path";
import { startOwner } from "../../../src/main";

const root = process.env.TEST_ROOT!;
try {
  const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home: join(root, "home") }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: process.env.ASH_TEST_DSH_ROOT!, home: join(root, "dsh"), env: {
      DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: process.env.TEST_MODEL_URL!,
    } } });
  await running.close();
  process.stdout.write("unexpected start\n");
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(`refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

import { Ledger, type WorkStage } from "../../../src/world/ledger";

const [file, target] = process.argv.slice(2) as [string, WorkStage];
if (!file || !["start-after-row", "start-before-commit", "start-after-commit", "end-after-row", "end-before-commit", "end-after-commit"].includes(target)) throw new Error("invalid synthetic kill stage");
const ledger = await Ledger.open(file, { workFailpoint(stage) { if (stage === target) process.kill(process.pid, "SIGKILL"); } });
if (target.startsWith("start")) ledger.workStart(null, "fixture", "manual");
else {
  const run = ledger.workRuns()[0]?.run;
  if (!run) throw new Error("missing synthetic active run");
  ledger.workFinish(run, "done", "completed");
}
ledger.close();
throw new Error("synthetic SIGKILL did not fire");

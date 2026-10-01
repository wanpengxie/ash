// Launch only the isolated WebView package with the synthetic URL from a mode-0600 file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("synthetic URL file required");
try {
  const url = readFileSync(file, "utf8").trim();
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "14762" || parsed.pathname !== "/") throw new Error("unexpected test URL");
  const adb = process.env.ASH_TEST_ADB || "adb";
  const base = ["-H", "127.0.0.1", "-P", "15037", "-s", "emulator-5554"];
  execFileSync(adb, [...base, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "-n", "ai.ash.v2screenprobe/.MainActivity"], { stdio: "ignore" });
  process.stdout.write("isolated Android WebView launched\n");
} catch {
  // ChildProcess errors may include spawnargs, including the disposable bearer URL.
  process.stderr.write("isolated Android WebView launch failed\n");
  process.exitCode = 1;
}

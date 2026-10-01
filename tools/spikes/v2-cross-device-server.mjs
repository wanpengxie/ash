// Ephemeral localhost-only echo owner for two separate browser surfaces.
// No token or URL is written to stdout; generated launch files are mode 0600.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { startOwner } = await import(process.env.ASH_PROBE_MAIN ?? "../../packages/core/src/main.ts");

const directory = mkdtempSync(join(tmpdir(), "ash-cross-device-"));
const port = 14762;
let running;
try {
  running = await startOwner({ stateDir: directory, listen: `127.0.0.1:${port}`, agents: [{ id: "agent:main", runtime: "echo" }] });
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")?.[0];
  if (!token) throw new Error("synthetic owner token missing");
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  const macScript = join(directory, "launch-mac.sh");
  writeFileSync(macScript, `#!/bin/zsh\nset -eu\nprobe_profile=$(mktemp -d /tmp/ash-v2-mac-screen-XXXXXX)\nopen -na 'Google Chrome' --args --user-data-dir="$probe_profile" --no-first-run --new-window '${url}' >/dev/null 2>&1\nprint -r -- "$probe_profile"\n`, { mode: 0o600 });
  writeFileSync(join(directory, "android-url"), url, { mode: 0o600 });
  running.world.subscribe((message) => {
    if (message.word === "say" && message.kind === "request" && message.from === "person:owner")
      process.stdout.write(JSON.stringify({ event: "owner.say", seq: message.seq, screen: message.origin?.screen ?? null, label: message.origin?.label ?? null }) + "\n");
  });
  process.stdout.write(JSON.stringify({ ready: true, port, fixtureDirectory: directory, macLaunchScript: macScript }) + "\n");
  const stop = async () => {
    process.removeAllListeners("SIGINT"); process.removeAllListeners("SIGTERM");
    await running.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
} catch (error) {
  if (running) await running.close();
  rmSync(directory, { recursive: true, force: true });
  throw error;
}

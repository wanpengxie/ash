import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = dirname(fileURLToPath(import.meta.url));

test("missing fixture executables never expose a synthetic token in errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "ash-screen-safety-"));
  const sentinel = "SENTINEL_PROBE_TOKEN_123";
  const urlFile = join(directory, "url");
  const stateFile = join(directory, "state.json");
  writeFileSync(urlFile, `http://127.0.0.1:14762/?token=${sentinel}`, { mode: 0o600 });
  try {
    for (const [script, mode, executable] of [
      ["v2-cross-device-android.mjs", null, "ASH_TEST_ADB"],
      ["v2-cross-device-mac-cdp.mjs", "start", "ASH_PROBE_CHROME"],
    ]) {
      const args = [join(source, script), ...(mode ? [mode] : []), urlFile, ...(mode ? [stateFile] : [])];
      const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, [executable]: join(directory, "not-installed") } });
      assert.equal(result.status, 1, script);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
      assert.doesNotMatch(result.stdout + result.stderr, /spawnargs|\/\?token=/i);
      assert.match(result.stderr, /isolated .* failed/);
      assert.equal(existsSync(stateFile), false);
    }
    assert.match(readFileSync(urlFile, "utf8"), new RegExp(sentinel));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

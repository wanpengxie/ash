import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_ASSETS } from "../src/device-assets.generated";
import { DEVICE_MIN_VERSION, DEVICE_VERSION, versionBefore } from "../src/versions";

test("versionBefore compares releases by number, not by text", () => {
  assert.equal(versionBefore("0.2.3", "0.2.4"), true);
  assert.equal(versionBefore("0.2.10", "0.2.9"), false);
  assert.equal(versionBefore("v0.9.0", "0.10.0"), true);
  assert.equal(versionBefore("0.2.4", "0.2.4"), false);
  assert.equal(versionBefore("dev", "0.2.4"), false, "what is not a version is never older");
  assert.equal(versionBefore(null, "0.2.4"), false);
});

test("the hub carries the checksums of the computer program it names, for every platform it ships", () => {
  assert.equal(DEVICE_ASSETS.version, DEVICE_VERSION, "package the computer program (tools/package-device.mjs --all) before building the hub");
  assert.deepEqual(Object.keys(DEVICE_ASSETS.sha256).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const sha of Object.values(DEVICE_ASSETS.sha256)) assert.match(sha, /^[a-f0-9]{64}$/);
  assert.ok(!versionBefore(DEVICE_VERSION, DEVICE_MIN_VERSION), "the hub's own release is never too old for it");
});

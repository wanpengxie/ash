import assert from "node:assert/strict";
import { test } from "node:test";
import { coreUiBytes, staticManifest, verifyStaticUi } from "../../../../tools/spikes/v2-604-ui-asset.mjs";

test("test-only static UI uses exactly the generated core bytes", () => {
  const bytes = coreUiBytes();
  const manifest = staticManifest(bytes);
  assert.equal(verifyStaticUi(bytes, manifest), true);
  assert.equal(manifest.bytes, bytes.length);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  const html = bytes.toString("utf8");
  assert.ok(!html.includes("/?token="));
  assert.ok(!html.includes("ash_ui"));
});

test("test-only static parity refuses altered bytes, digest and length", () => {
  const bytes = coreUiBytes();
  const manifest = staticManifest(bytes);
  const changed = Buffer.from(bytes);
  changed[changed.length - 2] ^= 1;
  assert.throws(() => verifyStaticUi(changed, manifest), /differs/);
  assert.throws(() => verifyStaticUi(bytes, { ...manifest, sha256: "0".repeat(64) }), /differs/);
  assert.throws(() => verifyStaticUi(bytes, { ...manifest, bytes: manifest.bytes + 1 }), /differs/);
});

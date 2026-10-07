import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { installRelease, releaseUrl, serviceDefinition } from "../src/install";

test("release installation verifies bytes, startup and platform before replacing the live version", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-install-test-")), source = join(root, "source", "ash-device");
  await mkdir(join(source, "bin"), { recursive: true });
  for (const file of ["node", "ash-device.mjs", "bin/ash-device"]) await writeFile(join(source, file), "fixture");
  await writeFile(join(source, "release.json"), JSON.stringify({ version: "0.1.0", platform: process.platform, arch: process.arch }));
  const archive = join(root, "fixture.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "ash-device"]);
  const bytes = await readFile(archive), hash = createHash("sha256").update(bytes).digest("hex");
  const old = join(root, "old"); await mkdir(old); await symlink(old, join(root, "current"));
  const fake = (async () => new Response(bytes)) as typeof fetch;
  await assert.rejects(installRelease(root, "0.1.0", "0".repeat(64), { fetch: fake }), /checksum/);
  assert.equal(await readlink(join(root, "current")), old);
  await assert.rejects(installRelease(root, "0.1.0", hash, { fetch: fake, check: async () => { throw new Error("bad startup"); } }), /bad startup/);
  assert.equal(await readlink(join(root, "current")), old);
  const result = await installRelease(root, "0.1.0", hash, { fetch: fake, check: async () => {} });
  assert.equal(result.previous, old); assert.equal(result.version, "0.1.0");
  assert.notEqual(await readlink(join(root, "current")), old);
  assert.equal(await readFile(join(root, "current", "ash-device.mjs"), "utf8"), "fixture");
  await symlink(old, join(source, "outside")); execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "ash-device"]);
  const links = await readFile(archive);
  await assert.rejects(installRelease(root, "0.1.0", createHash("sha256").update(links).digest("hex"), { fetch: (async () => new Response(links)) as typeof fetch }), /links/);
});

test("release names and user service definitions do not inject shell, XML or systemd options", () => {
  assert.throws(() => releaseUrl("../../main"));
  assert.match(releaseUrl("v0.1.0", "darwin", "arm64"), /device-v0\.1\.0\/ash-device-darwin-arm64.tar.gz$/);
  const mac = serviceDefinition("/Users/test/A&B", "darwin", "/usr/bin");
  assert.match(mac, /A&amp;B/); assert.match(mac, /KeepAlive/);
  const linux = serviceDefinition('/home/test/50% "app"', "linux", "/usr/bin");
  assert.match(linux, /50%%/); assert.match(linux, /Restart=always/); assert.doesNotMatch(linux, /User=root/);
});

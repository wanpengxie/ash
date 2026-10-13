import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, copyFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSync, constants, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
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

test("native helper archive validates hash/mode, runs only inherited fd, and tampering preserves current", async t => {
  const root = await mkdtemp(join(tmpdir(), "ash-install-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source", "ash-device"), archive = join(root, "native.tar.gz");
  await mkdir(join(source, "bin"), { recursive: true });
  for (const path of ["node", "ash-device.mjs", "bin/ash-device"]) await writeFile(join(source, path), "fixture");
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  await copyFile(join(dist, "ash-state-lock"), join(source, "ash-state-lock"));
  await copyFile(join(dist, "native-helper.json"), join(source, "native-helper.json"));
  await writeFile(join(source, "release.json"), JSON.stringify({ version: "0.1.0", platform: process.platform, arch: process.arch, native_state_lock: 1 }));
  const bundle = async () => {
    execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "ash-device"]);
    const bytes = await readFile(archive); return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  };
  const valid = await bundle();
  const result = await installRelease(root, "0.1.0", valid.hash, { fetch: (async () => new Response(valid.bytes)) as typeof fetch, check: async stage => {
    assert.equal((await stat(join(stage, "ash-state-lock"))).mode & 0o777, 0o755);
    assert.equal((await stat(join(stage, "native-helper.json"))).mode & 0o777, 0o644);
    const lockPath = join(root, "temporary-native-lock");
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const child = spawnSync(join(stage, "ash-state-lock"), [], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000 });
      assert.equal(child.status, 0); assert.equal(String(child.stdout), "ash-state-lock/1 acquired\n");
      const other = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
      try { assert.equal(spawnSync(join(stage, "ash-state-lock"), [], { stdio: ["ignore", "pipe", "pipe", other], timeout: 5000 }).status, 2); }
      finally { closeSync(other); }
    } finally { closeSync(fd); }
  } });
  assert.equal(result.previous, null);
  const current = await readlink(join(root, "current"));
  const metadata = JSON.parse(await readFile(join(current, "native-helper.json"), "utf8"));
  assert.equal(createHash("sha256").update(await readFile(join(current, "ash-state-lock"))).digest("hex"), metadata.sha256);
  await writeFile(join(source, "ash-state-lock"), Buffer.concat([await readFile(join(source, "ash-state-lock")), Buffer.from("corrupt")]));
  const corrupt = await bundle();
  await assert.rejects(installRelease(root, "0.1.0", corrupt.hash, { fetch: (async () => new Response(corrupt.bytes)) as typeof fetch, check: async () => { throw new Error("must fail hash before startup"); } }), /Native helper checksum/);
  assert.equal(await readlink(join(root, "current")), current);
});

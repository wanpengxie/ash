import assert from "node:assert/strict";
import test from "node:test";
import { inContainer, SHARED_STORAGE, storageBinds } from "../src/launch";

test("the phone's shared storage is bound at /sdcard and at its own path", () => {
  assert.deepEqual(storageBinds("/storage/emulated/0"), ["-b", "/storage/emulated/0:/sdcard", "-b", `/storage/emulated/0:${SHARED_STORAGE}`]);
  assert.deepEqual(storageBinds(null), []);
  const run = inContainer("/c", ["/bin/true"], { HOME: "/root" }, "/storage/emulated/0");
  const args = run.args;
  // Bound before the working directory and the command, next to the container's other binds.
  assert.ok(args.indexOf("/storage/emulated/0:/sdcard") > args.indexOf("/c/tmp:/tmp"));
  assert.ok(args.indexOf("/storage/emulated/0:/sdcard") < args.indexOf("-w"));
  assert.equal(args[args.length - 1], "/bin/true");
});

test("without shared storage the container binds nothing more", () => {
  const args = inContainer("/c", ["/bin/true"], {}, null).args;
  assert.equal(args.some((arg) => arg.includes("/sdcard")), false);
  assert.deepEqual(args.slice(0, 13), ["--kill-on-exit", "--link2symlink", "-0", "-r", "/c/ubuntu", "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "/c/tmp:/tmp"]);
});

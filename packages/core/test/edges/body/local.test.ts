import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { HandleContext, Message } from "../../../../sdk/src/message";
import { lintWords } from "../../../../sdk/src/word";
import { createLocalBody, bodyWords, mainBodyKind, type LocalBody } from "../../../src/edges/body/local";
import { createDshDriver, DEFAULT_ARGV } from "../../../src/edges/agents/dsh";
import { proxyEnv } from "../../../../sdk/src/proxy";
import type { ProotConfig } from "../../../src/edges/body/proot";

const caller = { member: "agent:cloud", via: "agent" as const, local: false };
let seq = 0;
const ask = (body: LocalBody, word: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
  body.handle({ seq: ++seq, id: `m${seq}`, ts: 1, from: caller.member, to: "body:main", kind: "request", word, body: args } as Message, { signal, caller, raw: args } satisfies HandleContext) as Promise<{ data: Record<string, any>; content: any[] }>;

interface Fixture { dir: string; rootfs: string; streams: { bytes: Uint8Array; mime: string }[]; body: LocalBody; ran: { command: string; cwd: string }[] }

/** A fake container root on the host: just a directory tree. Commands run on the host in the matching host directory. */
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  const rootfs = join(dir, "main", "ubuntu");
  await mkdir(join(rootfs, "etc"), { recursive: true });
  await mkdir(join(rootfs, "usr", "bin"), { recursive: true });
  await writeFile(join(rootfs, "etc", "os-release"), 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  await writeFile(join(rootfs, "usr", "bin", "apt-get"), "");
  const proot: ProotConfig = { root: join(dir, "main"), rootfs, bin: "/nonexistent/proot", loader: "", lib: "" };
  const streams: Fixture["streams"] = [];
  const ran: Fixture["ran"] = [];
  const body = createLocalBody({
    isolation: { kind: "proot", proot }, streams: (bytes, mime) => { streams.push({ bytes, mime }); return `st_${streams.length}`; },
    exec: (command, place) => { ran.push({ command, cwd: place.cwd }); return spawn("sh", ["-c", command], { cwd: place.hostCwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }); },
  });
  return { dir, rootfs, streams, body, ran };
}
const withFixture = (name: string, fn: (f: Fixture) => Promise<void>) => test(name, async () => {
  const f = await fixture();
  try { await fn(f); } finally { await f.body.close(); await rm(f.dir, { recursive: true, force: true }); }
});

withFixture("body:main is a body member whose words are the ten standard ones and pass the word lint", async ({ body }) => {
  assert.equal(body.id, "body:main");
  assert.equal(body.kind, "body");
  const words = body.words();
  assert.deepEqual(words.map((w) => w.word).sort(), ["body.info", "workspace.bash", "workspace.edit", "workspace.find", "workspace.grep", "workspace.ls", "workspace.poll", "workspace.read", "workspace.signal", "workspace.write"]);
  assert.ok(words.every((w) => w.member === "body:main" && w.kind === "request"));
  assert.deepEqual(lintWords(words), []);
  assert.deepEqual(bodyWords("body:abc").map((w) => w.member), Array(10).fill("body:abc"));
  const byWord = Object.fromEntries(words.map((w) => [w.word, w]));
  assert.equal(byWord["workspace.write"]!.per_call_risk, true);
  assert.equal(byWord["workspace.bash"]!.effect, "execute");
});

withFixture("SPEC-09 §7.1: the nine workspace actions and body.info work in the container's file system", async ({ body, rootfs, streams, ran }) => {
  // write, read, ls, edit, find, grep
  const wrote = await ask(body, "workspace.write", { path: "proj/hello.txt", content: "hello\nworld\n" });
  assert.equal(wrote.data.path, "/root/work/proj/hello.txt");
  assert.equal(await readFile(join(rootfs, "root", "work", "proj", "hello.txt"), "utf8"), "hello\nworld\n");
  assert.equal((await ask(body, "workspace.read", { path: "proj/hello.txt" })).data.text, "hello\nworld\n".trimEnd());
  assert.deepEqual((await ask(body, "workspace.ls", { path: "proj" })).data.entries.map((e: any) => e.name), ["hello.txt"]);
  await ask(body, "workspace.edit", { path: "proj/hello.txt", edits: [{ oldText: "world", newText: "there" }] });
  assert.equal((await ask(body, "workspace.read", { path: "/root/work/proj/hello.txt" })).data.text, "hello\nthere");
  assert.deepEqual((await ask(body, "workspace.find", { pattern: "**/*.txt" })).data.paths, ["/root/work/proj/hello.txt"]);
  assert.deepEqual((await ask(body, "workspace.grep", { pattern: "there" })).data.matches, [{ path: "/root/work/proj/hello.txt", line: 2, text: "there", context: false }]);
  // an image comes back through a stream, byte for byte
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1000, 0xfe)]);
  await writeFile(join(rootfs, "root", "work", "pic.png"), png);
  const image = await ask(body, "workspace.read", { path: "pic.png" });
  assert.deepEqual(image.content.at(-1), { type: "resource", stream: "st_1", mime: "image/png", size: png.length });
  assert.deepEqual(Buffer.from(streams[0]!.bytes), png);
  // bash starts in the work directory as the container names it, and sees what the file calls wrote
  const out = await ask(body, "workspace.bash", { command: "cat proj/hello.txt; echo done" });
  assert.equal(out.data.output, "hello\nthere\ndone\n");
  assert.equal(out.data.exit_code, 0);
  assert.deepEqual(ran, [{ command: "cat proj/hello.txt; echo done", cwd: "/root/work" }]);
  // a long command: poll, signal
  const long = await ask(body, "workspace.bash", { command: "echo start; sleep 30", yield_ms: 0 });
  assert.equal(long.data.running, true);
  const polled = await ask(body, "workspace.poll", { process: long.data.process, yield_ms: 30000 });
  assert.equal(polled.data.output, "start\n");
  assert.equal((await ask(body, "workspace.signal", { process: long.data.process, signal: "TERM" })).data.signalled, true);
  const ended = await ask(body, "workspace.poll", { process: long.data.process, yield_ms: 30000 });
  assert.equal(ended.data.running, false);
  assert.equal(typeof long.data.path, "string");
  assert.match(long.data.path, /^\/var\/tmp\/ash-workspace\/.*\.txt$/);
  assert.match(await readFile(join(rootfs, long.data.path), "utf8"), /^start\n/);
  // body.info: own, a full Linux
  const info = (await ask(body, "body.info", {})).data;
  assert.equal(info.ownership, "own");
  assert.equal(info.full_linux, true);
  assert.equal(info.system, "Ubuntu 24.04 LTS");
  assert.equal(info.package_manager, "apt");
  assert.equal(info.workdir, "/root/work");
});

withFixture("paths cannot leave the container: absolute links inside it resolve inside it, .. stops at its root", async ({ body, rootfs, dir }) => {
  await writeFile(join(dir, "host-secret"), "host");
  await writeFile(join(rootfs, "etc", "hostname"), "box\n");
  await mkdir(join(rootfs, "root", "work"), { recursive: true });
  await symlink(join(dir, "host-secret"), join(rootfs, "root", "work", "peek"));
  await assert.rejects(ask(body, "workspace.read", { path: "peek" }), (e: any) => e.code === "not_found");
  assert.equal((await ask(body, "workspace.read", { path: "../../../../../../etc/hostname" })).data.text, "box");
});

withFixture("SPEC-09 §7.5: a caller with no body of its own builds a file, runs a script and reads the result through body:main", async ({ body }) => {
  await ask(body, "workspace.write", { path: "job/run.sh", content: "echo computed $((6*7)) > out.txt\n" });
  const ran = await ask(body, "workspace.bash", { command: "sh run.sh", workdir: "job" });
  assert.equal(ran.data.exit_code, 0);
  assert.equal((await ask(body, "workspace.read", { path: "job/out.txt" })).data.text, "computed 42");
});

withFixture("assess: a write inside /root/work is none, anywhere else in the container the declared risk", async ({ body }) => {
  assert.equal(await body.assess({ word: "workspace.write", body: { path: "note.md", content: "x" } }), "none");
  assert.equal(await body.assess({ word: "workspace.edit", body: { path: "/etc/hosts", edits: [{ oldText: "a", newText: "b" }] } }), "structure");
  assert.equal(await body.assess({ word: "workspace.write", body: { path: "../../etc/x", content: "x" } }), "structure");
  assert.equal(await body.assess({ word: "workspace.bash", body: { command: "ls" } }), "structure");
});

test("a container that is not installed yet: calls say unavailable; nothing is created", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  try {
    const body = createLocalBody({ isolation: { kind: "proot", proot: { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: "x", loader: "x", lib: "x" } } });
    await assert.rejects(ask(body, "workspace.ls", {}), (e: any) => e.code === "unavailable");
    assert.equal(await body.assess({ word: "workspace.write", body: { path: "a", content: "" } }), null);
    await body.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

withFixture("a cancelled request aborts the call", async ({ body }) => {
  const abort = new AbortController();
  const pending = ask(body, "workspace.bash", { command: "sleep 30", yield_ms: 30000 }, abort.signal);
  abort.abort();
  await assert.rejects(pending, (e: any) => e.code === "cancelled");
});

test("isolation native (development machine, fake host): body:main is a directory and the machine's own shell", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  const workspace = join(dir, "ws");                       // not there yet: the body makes it
  const streams: Uint8Array[] = [];
  const askers: HandleContext["caller"][] = [];
  const body = createLocalBody({ isolation: { kind: "native", native: { workspace, dsh_bin: "dsh", dsh_home: join(dir, "dsh") } }, streams: (bytes, _mime, ctx) => { streams.push(bytes); askers.push(ctx.caller); return "st_1"; } });
  try {
    assert.equal(body.id, "body:main");
    assert.equal(body.words().length, 10);
    assert.equal(mainBodyKind({ kind: "native", native: { workspace, dsh_bin: "", dsh_home: "" } }), "native");
    await ask(body, "workspace.write", { path: "a/run.sh", content: "echo native $((1+1)) > out.txt\n" });
    assert.equal((await ask(body, "workspace.bash", { command: "sh run.sh && pwd", workdir: "a" })).data.exit_code, 0);
    const read = await ask(body, "workspace.read", { path: "a/out.txt" });
    assert.equal(read.data.text, "native 2");
    assert.equal(read.data.path, "/root/work/a/out.txt", "paths are the body's, as in the container: relative starts at /root/work");
    assert.equal(await readFile(join(workspace, "root", "work", "a", "out.txt"), "utf8"), "native 2\n");
    await writeFile(join(workspace, "root", "work", "blob.bin"), Buffer.from([0, 1, 2]));
    assert.equal((await ask(body, "workspace.read", { path: "blob.bin" })).data.stream, "st_1");
    assert.deepEqual(askers, [caller], "the stream goes back to whoever asked: the publisher gets the call's caller");
    assert.equal((await ask(body, "body.info", {})).data.ownership, "own");
    // The container's view: an absolute path starts at the workspace, and nothing gets out of it.
    await ask(body, "workspace.write", { path: "/root/agents/x/AGENTS.md", content: "hi" });
    assert.equal(await readFile(join(workspace, "root", "agents", "x", "AGENTS.md"), "utf8"), "hi");
    await assert.rejects(ask(body, "workspace.read", { path: "../../../../../../etc/hostname" }), (e: any) => e.code === "not_found", "`..` stops at the root: the host's /etc is not reachable");
    assert.equal(await body.assess({ word: "workspace.write", body: { path: "n.txt", content: "" } }), "none");
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("isolation container is not supported yet: unavailable", async () => {
  const body = createLocalBody({ isolation: { kind: "container", container: { engine: "docker", image: "x" } } });
  await assert.rejects(ask(body, "body.info", {}), (e: any) => e.code === "unavailable");
  assert.equal(mainBodyKind({ kind: "container", container: { engine: "docker", image: "x" } }), "container");
  await body.close();
});

test("spawn and appLauncher follow the isolation: native runs the host's runtime in the workspace, proot goes through the container, another kind cannot", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-spawn-"));
  try {
    const native = createLocalBody({ isolation: { kind: "native", native: { workspace: join(dir, "ws"), dsh_bin: process.execPath, dsh_home: join(dir, "dsh") } } });
    const child = native.spawn(["dsh", "-e", "process.stdout.write(process.cwd() + '|' + process.env.DSH_HOME + '|' + process.env.EXTRA)"], { cwd: "/root/agents/main", env: { EXTRA: "x" } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(out, `${await realpath(join(dir, "ws", "root", "agents", "main"))}|${join(dir, "dsh")}|x`);
    // `..` stops at the body's root; the runtime is told the machine path of a body path (the container: the path itself).
    const escaping = native.spawn(["dsh", "-e", "process.stdout.write(process.cwd())"], { cwd: "/root/../../../../../.." });
    let escaped = "";
    escaping.stdout.on("data", (chunk) => { escaped += chunk; });
    await new Promise((resolve) => escaping.on("close", resolve));
    assert.equal(escaped, await realpath(join(dir, "ws")), "never above the workspace");
    assert.equal(native.runtimePath("/root/work/../../../../x"), join(dir, "ws", "x"));
    assert.equal(native.runtimePath("sub"), join(dir, "ws", "root", "work", "sub"));
    // A relative place starts at the work directory, as in the container.
    const relative = native.spawn(["dsh", "-e", "process.stdout.write(process.cwd())"], { cwd: "sub" });
    let where = "";
    relative.stdout.on("data", (chunk) => { where += chunk; });
    await new Promise((resolve) => relative.on("close", resolve));
    assert.equal(where, await realpath(join(dir, "ws", "root", "work", "sub")));
    // Only `dsh` means the host's runtime: another program runs as written, without the runtime's home.
    const plain = native.spawn([process.execPath, "-e", "process.stdout.write(String(process.env.DSH_HOME) + '|' + process.env.EXTRA)"], { env: { EXTRA: "y" } });
    let plainOut = "";
    plain.stdout.on("data", (chunk) => { plainOut += chunk; });
    await new Promise((resolve) => plain.on("close", resolve));
    assert.equal(plainOut, `${process.env.DSH_HOME}|y`);
    const launcher = native.appLauncher()!;
    assert.equal(launcher.root, join(dir, "ws", "root", "apps"));
    assert.equal(launcher.agentRoot, "/root/apps", "the agent sees the same path in both forms");
    const run = launcher.spawn({ server: { command: "node", args: ["server.mjs"], env: { A: "1" } } } as never, join(launcher.root, "notes"), { ASH_X: "y" });
    assert.deepEqual([run.command, run.args, run.cwd, run.env.A, run.env.ASH_X], ["node", ["server.mjs"], join(launcher.root, "notes"), "1", "y"]);

    const proot: ProotConfig = { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: "/nonexistent/proot", loader: "", lib: "" };
    const containedBody = createLocalBody({ isolation: { kind: "proot", proot } });
    assert.equal(containedBody.runtimePath("/root/work"), "/root/work");
    const contained = containedBody.appLauncher()!;
    assert.equal(contained.root, join(proot.rootfs, "root", "apps"));
    assert.equal(contained.agentRoot, "/root/apps");
    const inside = contained.spawn({ server: { command: "node", args: ["server.mjs"] } } as never, join(contained.root, "notes"), { ASH_X: "y" });
    assert.equal(inside.command, "/nonexistent/proot");
    assert.ok(inside.args.join(" ").includes("-w /root/apps/notes") && inside.args.includes("ASH_X=y") && inside.args.at(-2) === "node");

    const other = createLocalBody({ isolation: { kind: "container", container: { engine: "docker", image: "x" } } });
    assert.equal(other.appLauncher(), null);
    assert.throws(() => other.spawn(["x"]), (error: any) => error.code === "unavailable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const startSpec = { runtime: { kind: "dsh" }, native: { on: "body:main", cwd: "agents/main" }, tools: { mcp_url: "http://127.0.0.1:1/mcp", tokens: { front: "t" }, allowed: [] }, modules: { static: [] }, lanes: ["front"], sessions: {} };

test("the dsh driver's default argv, through a native body: it is the host's dsh_bin, with DSH_HOME and the host's patch file", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-dsh-"));
  try {
    assert.equal(DEFAULT_ARGV[0], "dsh", "the driver only names the runtime; the body knows where it is");
    const record = join(dir, "record");
    const fake = join(dir, "fake-dsh");
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$0" "$@" "HOME=$DSH_HOME" > ${record}\n`);
    await chmod(fake, 0o755);
    const patched = createLocalBody({ isolation: { kind: "native", native: { workspace: join(dir, "ws"), dsh_bin: fake, dsh_home: join(dir, "dsh"), dsh_patch: join(dir, "patch.yml") } } });
    const driver = createDshDriver({ report: () => {}, spawn: (argv, o) => patched.spawn(argv, o), writeFile: async () => {} });
    await assert.rejects(driver.start("agent:main", startSpec as never));         // the fake exits without speaking ACP
    assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [fake, "--profile", "acp", "--patch", join(dir, "patch.yml"), `HOME=${join(dir, "dsh")}`]);

    // No patch file on this machine: the option goes away with its value.
    const bare = createLocalBody({ isolation: { kind: "native", native: { workspace: join(dir, "ws"), dsh_bin: fake, dsh_home: join(dir, "dsh") } } });
    const second = createDshDriver({ report: () => {}, spawn: (argv, o) => bare.spawn(argv, o), writeFile: async () => {} });
    await assert.rejects(second.start("agent:main", startSpec as never));
    assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [fake, "--profile", "acp", `HOME=${join(dir, "dsh")}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("in the container, `dsh` becomes /opt/dsh/node_modules/.bin/dsh and the patch path stays", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-proot-"));
  try {
    const record = join(dir, "record");
    const proot = join(dir, "proot");
    await writeFile(proot, `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\n`);
    await chmod(proot, 0o755);
    const config: ProotConfig = { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: proot, loader: "", lib: "" };
    const body = createLocalBody({ isolation: { kind: "proot", proot: config } });
    const child = body.spawn(DEFAULT_ARGV, { cwd: "/root/agents/main" });
    await new Promise((resolve) => child.on("close", resolve));
    const args = (await readFile(record, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(-5), ["/opt/dsh/node_modules/.bin/dsh", "--profile", "acp", "--patch", "/opt/ash/patch.yml"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("in the container, `dsh` runs with telemetry off and DSH's own sandbox off; other programs get only what the caller gives", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-env-"));
  try {
    const record = join(dir, "record");
    const proot = join(dir, "proot");
    await writeFile(proot, `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\n`);
    await chmod(proot, 0o755);
    const config: ProotConfig = { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: proot, loader: "", lib: "" };
    const body = createLocalBody({ isolation: { kind: "proot", proot: config } });
    const inside = async (argv: string[], env?: Record<string, string>) => {
      const child = body.spawn(argv, env ? { env } : {});
      await new Promise((resolve) => child.on("close", resolve));
      return (await readFile(record, "utf8")).trim().split("\n");
    };
    const dsh = await inside(DEFAULT_ARGV, { DEEPSEEK_BASE_URL: "http://x" });
    for (const pair of ["DSH_PERMISSION_MODE=danger-full-access", "DSH_TELEMETRY_DISABLED=1", "DSH_HOME=/root/.dsh", "DEEPSEEK_BASE_URL=http://x"]) assert.ok(dsh.includes(pair), pair);
    const other = await inside(["ls"], { A: "1" });
    assert.ok(other.includes("A=1"));
    assert.ok(!other.some((arg) => arg.startsWith("DSH_PERMISSION_MODE")), "only the agent runtime is told its sandbox is off");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

withFixture("opening the body writes the host's DNS servers into the container's resolv.conf; spawning does too, once the image exists", async (f) => {
  const resolv = join(f.rootfs, "etc", "resolv.conf");
  await writeFile(resolv, "nameserver 10.0.0.1\n");
  await ask(f.body, "workspace.ls", { path: "/" });
  assert.equal(await readFile(resolv, "utf8"), "nameserver 223.5.5.5\nnameserver 119.29.29.29\n", "no servers named: the defaults");

  const proot: ProotConfig = { root: join(f.dir, "main"), rootfs: f.rootfs, bin: "/bin/true", loader: "", lib: "", dns: ["1.1.1.1", "not a server; rm", "2606:4700:4700::1111"] };
  const other = createLocalBody({ isolation: { kind: "proot", proot } });
  try {
    other.spawn(["true"]).on("error", () => {});
    assert.equal(await readFile(resolv, "utf8"), "nameserver 1.1.1.1\nnameserver 2606:4700:4700::1111\n");
  } finally { await other.close(); }
});

withFixture("the container gets a CA bundle from Node's roots when it has none; one already there is kept", async (f) => {
  const bundle = join(f.rootfs, "etc", "ssl", "certs", "ca-certificates.crt");
  await ask(f.body, "workspace.ls", { path: "/" });
  const written = await readFile(bundle, "utf8");
  assert.ok(written.split("BEGIN CERTIFICATE").length > 50, "Node's roots");
  await writeFile(bundle, "apt's bundle\n");
  const proot: ProotConfig = { root: join(f.dir, "main"), rootfs: f.rootfs, bin: "/bin/true", loader: "", lib: "" };
  const other = createLocalBody({ isolation: { kind: "proot", proot } });
  try {
    other.spawn(["true"]).on("error", () => {});
    assert.equal(await readFile(bundle, "utf8"), "apt's bundle\n");
  } finally { await other.close(); }
});

test("the DNS servers are not written before the image is installed", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-dns-"));
  try {
    const proot: ProotConfig = { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: "/bin/true", loader: "", lib: "", dns: ["9.9.9.9"] };
    createLocalBody({ isolation: { kind: "proot", proot } }).spawn(["true"]).on("error", () => {});
    await assert.rejects(readFile(join(dir, "main", "ubuntu", "etc", "resolv.conf"), "utf8"), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** A fake proot: records what the body asked for and ends at once with the exit code the test wants. */
function fakeProot(exitCode = 0, output = "") {
  const runs: { argv: string[]; env: Record<string, string> | undefined; detached: boolean | undefined }[] = [];
  const run = (_proot: ProotConfig, argv: string[], opts: { env?: Record<string, string>; detached?: boolean }) => {
    runs.push({ argv, env: opts.env, detached: opts.detached });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    setImmediate(() => { if (output) child.stdout.write(output); child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", exitCode, null)); });
    return child as never;
  };
  return { runs, run };
}
async function prootDir(files: string[] = []): Promise<{ dir: string; proot: ProotConfig }> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-proot-"));
  const rootfs = join(dir, "main", "ubuntu");
  await mkdir(join(rootfs, "usr", "bin"), { recursive: true });
  for (const name of files) await writeFile(join(rootfs, "usr", "bin", name), "");
  return { dir, proot: { root: join(dir, "main"), rootfs, bin: "/nonexistent/proot", loader: "", lib: "" } };
}
const NO_PROXY_LOOPBACK = "127.0.0.1,localhost,::1";

test("the host's proxy reaches the runtime, workspace commands and app servers in the container; NO_PROXY always keeps loopback", async () => {
  const { dir, proot } = await prootDir();
  const fake = fakeProot();
  const body = createLocalBody({
    isolation: { kind: "proot", proot }, runProot: fake.run,
    network: { proxy: { http: "http://10.0.2.2:7890", https: "http://10.0.2.2:7891", no_proxy: "*.corp" } },
  });
  try {
    body.spawn(["dsh", "--profile", "acp"], { env: { EXTRA: "1" } });
    const spawned = fake.runs[0]!;
    assert.equal(spawned.env!.HTTP_PROXY, "http://10.0.2.2:7890");
    assert.equal(spawned.env!.http_proxy, "http://10.0.2.2:7890");
    assert.equal(spawned.env!.HTTPS_PROXY, "http://10.0.2.2:7891");
    assert.equal(spawned.env!.https_proxy, "http://10.0.2.2:7891");
    assert.equal(spawned.env!.NO_PROXY, `*.corp,${NO_PROXY_LOOPBACK}`);
    assert.equal(spawned.env!.no_proxy, `*.corp,${NO_PROXY_LOOPBACK}`);
    assert.equal(spawned.env!.EXTRA, "1");
    assert.equal(spawned.env!.DSH_PERMISSION_MODE, "danger-full-access", "the runtime's own variables stay");

    await mkdir(join(proot.rootfs, "root", "work"), { recursive: true });
    await ask(body, "workspace.bash", { command: "echo hi", yield_ms: 2000 });
    const exec = fake.runs.find((run) => run.argv[0] === "/bin/bash")!;
    assert.equal(exec.env!.HTTPS_PROXY, "http://10.0.2.2:7891");
    assert.equal(exec.env!.no_proxy, `*.corp,${NO_PROXY_LOOPBACK}`);

    const app = body.appLauncher()!.spawn({ server: { command: "node", args: ["s.mjs"] } } as never, join(proot.rootfs, "root", "apps", "notes"), {});
    assert.ok(app.args.includes("HTTP_PROXY=http://10.0.2.2:7890") && app.args.includes(`NO_PROXY=*.corp,${NO_PROXY_LOOPBACK}`));
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("NO_PROXY is the loopback alone when the host excluded nothing; a proxy of one scheme sets only that scheme", async () => {
  const { dir, proot } = await prootDir();
  const fake = fakeProot();
  const body = createLocalBody({ isolation: { kind: "proot", proot }, runProot: fake.run, network: { proxy: { http: "http://p:1" } } });
  try {
    body.spawn(["echo"]);
    const env = fake.runs[0]!.env!;
    assert.equal(env.NO_PROXY, NO_PROXY_LOOPBACK);
    assert.equal(env.HTTP_PROXY, "http://p:1");
    assert.equal("HTTPS_PROXY" in env || "https_proxy" in env, false);
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the program named `pi` is the pi runtime inside the container, and what the driver sets for the process wins over the phone's own proxy", async () => {
  const { dir, proot } = await prootDir();
  const fake = fakeProot();
  const body = createLocalBody({ isolation: { kind: "proot", proot }, runProot: fake.run, network: { proxy: { https: "http://phone:1" } } });
  try {
    body.spawn(["pi", "--mode", "rpc"], { env: { HTTPS_PROXY: "http://127.0.0.1:20171", NO_PROXY: "api.deepseek.com" }, cwd: "/root/agents/main" });
    const run = fake.runs[0]!;
    assert.deepEqual(run.argv, ["/opt/pi/node_modules/.bin/pi", "--mode", "rpc"]);
    assert.equal(run.env!.HTTPS_PROXY, "http://127.0.0.1:20171");
    assert.equal(run.env!.NO_PROXY, "api.deepseek.com");
    assert.equal(run.env!.DSH_HOME, undefined, "pi does not get DSH's environment");
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("env.changed: setNetwork gives the next process the new proxy, and clears it when the host has none", async () => {
  const { dir, proot } = await prootDir();
  const fake = fakeProot();
  const body = createLocalBody({ isolation: { kind: "proot", proot }, runProot: fake.run });
  try {
    body.spawn(["echo", "1"]);
    body.setNetwork({ proxy: { http: "http://new:1", https: "http://new:2" } });
    body.spawn(["echo", "2"]);
    body.setNetwork({ proxy: { https: "http://newer:3" } });
    body.spawn(["echo", "3"]);
    body.setNetwork({ proxy: null });
    body.spawn(["echo", "4"]);
    const [first, second, third, fourth] = fake.runs.map((run) => run.env!);
    assert.equal(Object.keys(first!).some((key) => /proxy/i.test(key)), false);
    assert.equal(second!.HTTP_PROXY, "http://new:1");
    assert.equal(second!.https_proxy, "http://new:2");
    assert.equal(third!.HTTPS_PROXY, "http://newer:3");
    assert.equal("HTTP_PROXY" in third!, false, "the old http proxy does not linger");
    assert.equal(Object.keys(fourth!).some((key) => /proxy/i.test(key)), false);
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("python3 is installed in the background only when provisionLater is called: once, log in the state directory, a failure is only a log line", async () => {
  const { dir, proot } = await prootDir(["apt-get"]);
  const stateDir = join(dir, "state");
  const fake = fakeProot(100, "E: no network\n");
  const body = createLocalBody({
    isolation: { kind: "proot", proot }, runProot: fake.run, stateDir,
    network: { proxy: { http: "http://p:1" } }, env: { FROM: "options" },
  });
  const installs = () => fake.runs.filter((run) => run.argv[0] === "/bin/sh");
  try {
    // The first meeting is not slowed by it: starting the runtime and opening the workspace install nothing.
    body.spawn(["dsh"]);
    body.spawn(["echo"]);
    await ask(body, "workspace.ls", {});
    assert.equal(installs().length, 0);
    body.provisionLater();
    body.provisionLater();
    assert.equal(installs().length, 1, "started once, at once, without waiting");
    assert.ok(installs()[0]!.argv[2]!.startsWith("dpkg --configure -a; "), "a half-installed package is put right first");
    assert.ok(installs()[0]!.argv[2]!.includes("apt-get") && installs()[0]!.argv[2]!.includes("python3"));
    assert.equal(installs()[0]!.env!.HTTP_PROXY, "http://p:1", "apt goes through the phone's proxy too");
    assert.equal(installs()[0]!.env!.FROM, "options");
    for (let i = 0; i < 100 && !(await readFile(join(stateDir, "container-provision.log"), "utf8").catch(() => "")).includes("failed"); i++) await new Promise((r) => setTimeout(r, 10));
    const log = await readFile(join(stateDir, "container-provision.log"), "utf8");
    assert.ok(log.includes("E: no network") && log.includes("failed: exit 100"), log);
    // A failed attempt is not repeated in this run.
    body.provisionLater();
    body.spawn(["echo"]);
    assert.equal(installs().length, 1);
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an attempt that did not start does not use up the one try", async () => {
  const { dir, proot } = await prootDir([]);
  const fake = fakeProot();
  const body = createLocalBody({ isolation: { kind: "proot", proot }, runProot: fake.run, stateDir: join(dir, "state") });
  try {
    body.provisionLater(); // no apt-get in the image yet
    assert.equal(fake.runs.length, 0);
    await writeFile(join(proot.rootfs, "usr", "bin", "apt-get"), "");
    body.provisionLater();
    assert.equal(fake.runs.length, 1);
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("python3 is not installed when the image has it, has no apt-get, the body has no state directory, or it is not a container", async () => {
  for (const [files, withState] of [[["apt-get", "python3"], true], [[], true], [["apt-get"], false]] as const) {
    const { dir, proot } = await prootDir([...files]);
    const fake = fakeProot();
    const body = createLocalBody({ isolation: { kind: "proot", proot }, runProot: fake.run, ...(withState ? { stateDir: join(dir, "state") } : {}) });
    try {
      body.provisionLater();
      assert.equal(fake.runs.filter((run) => run.argv[0] === "/bin/sh").length, 0, `${files.join(",")} state=${withState}`);
    } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
  }
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-native-"));
  const fake = fakeProot();
  const body = createLocalBody({ isolation: { kind: "native", native: { workspace: join(dir, "ws"), dsh_bin: "dsh", dsh_home: join(dir, "home") } }, runProot: fake.run, stateDir: join(dir, "state") });
  try {
    body.provisionLater();
    assert.equal(fake.runs.length, 0);
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("NO_PROXY names each loopback address once, even when the host already listed some; a proxy turns Node's own proxy support on", async () => {
  const env = proxyEnv({ proxy: { http: "http://p:1", no_proxy: " localhost , *.corp,127.0.0.1 ," } });
  assert.equal(env.NO_PROXY, "localhost,*.corp,127.0.0.1,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(proxyEnv({ proxy: { http: "http://p:1" } }).NO_PROXY, NO_PROXY_LOOPBACK);
  assert.deepEqual(proxyEnv({ proxy: null }), {}, "no proxy, no Node switch either");
  assert.deepEqual(proxyEnv({ proxy: {} }), {});
});

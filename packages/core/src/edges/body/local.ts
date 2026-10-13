/**
 * The main body, member `body:main` (SPEC-09 §1, HUB-MODULES §2.6): the file system and shell the kernel carries.
 * The host's `isolation.kind` picks the implementation (SPEC-07 §2.2):
 * - `proot`: the Ubuntu root is read and written from the host side with `packages/workspace`; commands run inside the
 *   container through proot.
 * - `native`: no container; a directory on this machine and its shell (development machines, the fake host). The directory
 *   stands for the container's root: a path on this body means the same thing in both forms (`/root/work`, `/root/agents/x`
 *   are `<workspace>/root/work`, ...), and a relative one starts at `/root/work`. Only the body knows this translation.
 *   There is no real chroot here: `workspace.bash` and the runtime's own tools (DSH's shell) run on the machine and see the
 *   machine's paths, so a program is given `runtimePath(cwd)`, the machine path of a body path.
 */
import { spawn as spawnProcess, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import tls from "node:tls";
import type { HostIsolation, HostNetwork } from "../../../../sdk/src/host";
import { MAIN_BODY_ID } from "../../../../sdk/src/ids";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { standardContracts } from "../../../../sdk/src/namespaces";
import type { Member, Risk, WordContract } from "../../../../sdk/src/word";
import { Workspace, type Executor } from "../../../../workspace/src";
import type { AppJson } from "../../../../sdk/src/app";
import { proxyEnv } from "../../../../sdk/src/proxy";
import { PROOT_WORKDIR, prootCommand, prootMounts, reapContainer, runInProot, type ProotConfig, type ProotSpawnOptions } from "./proot";
import { startProvision, type ProvisionState } from "./provision";

/** Where DSH and its patch file are inside the container; the agent runtime only says `dsh --patch <that file>`. */
const PROOT_DSH = "/opt/dsh/node_modules/.bin/dsh";
/** Where pi (the other agent runtime) is inside the container; the driver only says `pi`. */
const PROOT_PI = "/opt/pi/node_modules/.bin/pi";
const PROOT_PATCH = "/opt/ash/patch.yml";

/**
 * What DSH runs with inside the container: no telemetry, and its own sandbox and approval prompts off as a pair, because the
 * container is the sandbox. The body is the one that knows how DSH is started, so it sets these (the driver's own env is added).
 */
const PROOT_DSH_ENV: Record<string, string> = { DSH_TELEMETRY_DISABLED: "1", DSH_PERMISSION_MODE: "danger-full-access", DSH_HOME: "/root/.dsh" };
/** Used when the host names no DNS servers (or none that are addresses). */
export const DEFAULT_DNS = ["223.5.5.5", "119.29.29.29"];

/**
 * The container's `etc/resolv.conf` from the host's DNS servers (`isolation.proot.dns`): the phone's own resolver is not
 * reachable from inside. Written only when it differs; nothing happens while the image is not installed.
 */
export function writeResolvConf(proot: ProotConfig): void {
  const etc = join(proot.rootfs, "etc");
  if (!existsSync(etc)) return;
  const servers = (proot.dns ?? []).filter((server) => /^[0-9a-fA-F:.]{2,45}$/.test(server));
  const text = `${(servers.length ? servers : DEFAULT_DNS).map((server) => `nameserver ${server}`).join("\n")}\n`;
  const file = join(etc, "resolv.conf");
  try { if (!lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8") === text) return; } catch { /* missing: write it */ }
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: 0o644 });
  rmSync(file, { force: true });
  renameSync(temp, file);
}

/**
 * The container's CA bundle (`etc/ssl/certs/ca-certificates.crt`), from Node's own roots, when the image has none: the
 * base image carries no ca-certificates package, and a program that reads the system roots (Go's, such as v2rayA and its
 * core) cannot verify any TLS server without it. A bundle already there (apt's ca-certificates) is left alone.
 */
export function writeCaBundle(proot: ProotConfig): void {
  const dir = join(proot.rootfs, "etc", "ssl", "certs");
  if (!existsSync(join(proot.rootfs, "etc"))) return;
  const file = join(dir, "ca-certificates.crt");
  try { if (statSync(file).size > 0) return; } catch { /* missing: write it */ }
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${tls.rootCertificates.join("\n")}\n`, { mode: 0o644 });
  rmSync(file, { force: true });
  renameSync(temp, file);
}

/** DSH's arguments on this machine: its `--patch` file is the host's own, or none. */
function nativeRuntimeArgs(args: string[], patch: string | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--patch" && args[i + 1] === PROOT_PATCH) { if (patch) out.push("--patch", patch); i++; } else out.push(args[i]!);
  }
  return out;
}

/** The machine path of a body path in a native workspace: absolute from the body's root, relative from `/root/work`, `..` stops at the root. */
const nativePath = (workspace: string, cwd: string): string => join(workspace, posix.resolve(PROOT_WORKDIR, cwd));

export interface LocalBodyOptions {
  /** How the host isolates the main body (host.json `isolation`). */
  isolation: HostIsolation;
  /** How a binary or large file travels to the caller of a `workspace.read` (SPEC-03 §3.4): on the channel the call came in through. */
  streams?: (data: Uint8Array, mime: string, ctx: HandleContext) => string;
  /** Extra environment for commands inside the container (proot only). */
  env?: Record<string, string>;
  /** The host's network now (`spec.network`): its proxy goes into every program started in the container (proot only). */
  network?: HostNetwork;
  /** The hub's state directory: the one-time installation of python3 writes `container-provision.log` there. Absent: no installation. */
  stateDir?: string;
  /** Starts a command in the container (default `runInProot`): for tests. */
  runProot?: (proot: ProotConfig, argv: string[], opts: ProotSpawnOptions) => ChildProcess;
  /** Runs a command instead of the default (proot, or the machine's own shell for native): for tests and unusual hosts. */
  exec?: Executor;
  /** Where the body says what it did on its own (default: standard error). */
  log?: (line: string) => void;
}

/** How the apps module starts an app's server and where the apps live (the shape of its `AppLauncher`). */
export interface BodyAppLauncher {
  /** The folder holding one folder per app, as the hub sees it. */
  root: string;
  /** The same folder as the agent sees it, when that differs. */
  agentRoot?: string;
  spawn(app: AppJson, dir: string, env: Record<string, string>): { command: string; args: string[]; env: Record<string, string>; cwd?: string };
}

export interface LocalBody extends Member {
  /**
   * Starts a program on this body with piped stdio (the agent runtime's process). `cwd` is a path on the body. Where and how
   * it runs depends on the isolation: in the container through proot, or directly on this machine for `native`.
   * The program named `dsh` is the agent runtime: only the body knows where it is (and its `--patch` file) in either form.
   */
  spawn(argv: string[], opts?: { env?: Record<string, string>; cwd?: string }): ChildProcessWithoutNullStreams;
  /**
   * The path a program started on this body should be told for a body path (`cwd`): the same path in the container, the
   * machine's own path under the workspace for `native`. For what the runtime is told about its place (the session's cwd),
   * not for the hub's own file calls, which take body paths.
   */
  runtimePath(cwd: string): string;
  /** Where the apps live on this body and how their servers are started; null when this body cannot run them. */
  appLauncher(): BodyAppLauncher | null;
  /** The risk of one call (SPEC-01 §6.3): a write inside the work directory is none. For the gate's `assess`. */
  assess(msg: Pick<Message, "word" | "body">): Promise<Risk | null>;
  /** The host's network changed: programs started from now on get the new proxy (those already running keep theirs). */
  setNetwork(network: HostNetwork): void;
  /**
   * Installs python3 in the container in the background, if the image lacks it: never waited for, once in this run, its
   * output in `container-provision.log` of the state directory. Called once the main agent is up, so the first meeting is
   * not slowed by it. Does nothing for a body that is not a proot container or has no state directory.
   */
  provisionLater(): void;
  /** Stops commands still running (kernel shutdown). */
  close(): Promise<void>;
}

/** The `bodies.kind` of the main body for this isolation. */
export const mainBodyKind = (isolation: HostIsolation): string => (isolation.kind === "proot" ? "proot-ubuntu" : isolation.kind);

/** The words of any body: the standard `workspace.*` and `body.info`, addressed to this member. */
export const bodyWords = (id: string): WordContract[] =>
  standardContracts().filter((contract) => contract.member === "body:*").map((contract) => ({ ...contract, member: id }));

export function createLocalBody(o: LocalBodyOptions): LocalBody {
  let workspace: Workspace | null = null;
  let network: HostNetwork | null = o.network ?? null;
  const runProot = o.runProot ?? runInProot;
  const provisioning: ProvisionState = { phase: "idle" };
  // The container may not be installed yet when the kernel starts; the body appears when its files do.
  const open = (): Workspace => {
    if (workspace) return workspace;
    const isolation = o.isolation;
    if (isolation.kind === "native") {
      mkdirSync(join(isolation.native.workspace, PROOT_WORKDIR), { recursive: true });
      return workspace = new Workspace({
        root: isolation.native.workspace, chroot: true, workdir: PROOT_WORKDIR, ownership: "own", exec: o.exec,
        spillDir: join(isolation.native.workspace, "var", "tmp", "ash-workspace"),
      });
    }
    if (isolation.kind !== "proot") throw new WordError("unavailable", `The ${isolation.kind} main body is not supported yet`);
    const proot = isolation.proot;
    if (!existsSync(proot.rootfs)) throw new WordError("unavailable", "The main body is not installed yet");
    mkdirSync(join(proot.rootfs, PROOT_WORKDIR), { recursive: true });
    writeResolvConf(proot);
    writeCaBundle(proot);
    return workspace = new Workspace({
      root: proot.rootfs, chroot: true, workdir: PROOT_WORKDIR, ownership: "own", mounts: prootMounts(proot),
      exec: o.exec ?? ((command, place) => runProot(proot, ["/bin/bash", "-c", command], { workdir: place.cwd, env: { ...proxyEnv(network), ...o.env }, detached: true })),
      // Command output is kept in the container's own /var/tmp, where a file call can read it too.
      spillDir: join(proot.rootfs, "var", "tmp", "ash-workspace"),
    });
  };
  const isolation = o.isolation;
  // A core that handed over to the other host mode, or was killed, can leave its agents and apps running in the
  // container: end them before this core starts its own.
  if (isolation.kind === "proot") {
    const ended = reapContainer(isolation.proot);
    if (existsSync(isolation.proot.rootfs)) writeCaBundle(isolation.proot);
    if (ended) (o.log ?? ((line: string) => console.error(line)))(`[body] ended ${ended} process(es) an earlier core left in the container`);
  }
  return {
    id: MAIN_BODY_ID,
    kind: "body",
    name: "main body",
    words: () => bodyWords(MAIN_BODY_ID),
    spawn(argv, opts = {}) {
      if (isolation.kind === "proot") {
        writeResolvConf(isolation.proot);
        writeCaBundle(isolation.proot);
        const runtime = argv[0] === "dsh";
        const program = runtime ? [PROOT_DSH, ...argv.slice(1)] : argv[0] === "pi" ? [PROOT_PI, ...argv.slice(1)] : argv;
        return runProot(isolation.proot, program, {
          // Its own process group: stopping it reaches what runs under proot too (proot does not pass a signal on).
          ...(opts.cwd ? { workdir: opts.cwd } : {}), env: { ...proxyEnv(network), ...(runtime ? PROOT_DSH_ENV : {}), ...opts.env }, stdio: ["pipe", "pipe", "pipe"], detached: true,
        }) as ChildProcessWithoutNullStreams;
      }
      if (isolation.kind === "native") {
        // The development form: the program runs straight on this machine, its place under the workspace (the path on the
        // body, as in the container: absolute from the root, relative from the work directory). `dsh` is the runtime the
        // host names (its binary, home and patch file); any other program runs as written.
        const cwd = nativePath(isolation.native.workspace, opts.cwd ?? "");
        mkdirSync(cwd, { recursive: true });
        const runtime = argv[0] === "dsh";
        const { dsh_bin, dsh_home, dsh_patch } = isolation.native;
        return spawnProcess(runtime ? dsh_bin : argv[0]!, runtime ? nativeRuntimeArgs(argv.slice(1), dsh_patch) : argv.slice(1), {
          cwd, env: { ...process.env, ...(runtime ? { DSH_HOME: dsh_home } : {}), ...opts.env }, stdio: ["pipe", "pipe", "pipe"],
        });
      }
      throw new WordError("unavailable", `The ${isolation.kind} main body cannot run a program yet`);
    },
    runtimePath: (cwd) => (isolation.kind === "native" ? nativePath(isolation.native.workspace, cwd) : cwd),
    appLauncher() {
      if (isolation.kind === "native") {
        return {
          root: join(isolation.native.workspace, "root", "apps"), agentRoot: "/root/apps",
          spawn: (app, dir, env) => ({
            command: app.server.command, args: app.server.args ?? [], cwd: dir,
            env: { HOME: process.env.HOME ?? "/root", PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8", TERM: "dumb", ...(app.server.env ?? {}), ...env },
          }),
        };
      }
      if (isolation.kind === "proot") {
        const proot = isolation.proot;
        return {
          root: join(proot.rootfs, "root", "apps"), agentRoot: "/root/apps",
          spawn: (app, dir, env) => {
            const run = prootCommand(proot, [app.server.command, ...(app.server.args ?? [])], { workdir: `/root/apps/${dir.split("/").pop()}`, env: { ...proxyEnv(network), ...(app.server.env ?? {}), ...env } });
            return { command: run.command, args: run.args, env: run.env };
          },
        };
      }
      return null;
    },
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      const streams = o.streams;
      return open().call(msg.word, (msg.body ?? {}) as Record<string, unknown>, { signal: ctx.signal, ...(streams ? { streams: (data, meta) => streams(data, meta.mime, ctx) } : {}) });
    },
    async assess(msg) {
      try { return await open().assess(msg.word, (msg.body ?? {}) as Record<string, unknown>); } catch { return null; }
    },
    setNetwork(next) { network = next; },
    provisionLater() {
      if (isolation.kind !== "proot" || !o.stateDir || !existsSync(isolation.proot.rootfs)) return;
      const proot = isolation.proot;
      startProvision(proot, o.stateDir, (argv) => runProot(proot, argv, { env: { ...proxyEnv(network), ...o.env } }), provisioning);
    },
    async close() { await workspace?.close(); },
  };
}

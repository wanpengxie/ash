import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the agent runtime lives. `proot` is the product; `direct` runs the same DSH without a container, for tests. */
export interface ContainerConfig {
  root: string;
  dns?: string[];
  env?: Record<string, string>;
  model?: { provider: string; model: string };
  direct?: { dshBin: string; dshHome: string; workspace: string; pluginPath: string };
  /** Tests only: where the model egress forwards instead of the provider. */
  modelUpstream?: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The workspace as the host (ash) sees it: persona and memory files, attachments for the agent. */
  hostWorkspace: string;
  /** The same directory as the agent sees it: every ACP session's cwd. */
  agentWorkspace: string;
  /** Map a host path inside the workspace to the path the agent sees. */
  toAgentPath(hostPath: string): string;
  /** A declared agent's own workspace (created if missing), as the host and as the agent see it. */
  agentHome(name: string): { host: string; agent: string };
  mode: "proot" | "direct";
}

/** The model key the container is given. It is not a secret: ash swaps it for the vault key at the egress. */
export const PLACEHOLDER_KEY = "sk-ash-placeholder-the-real-key-stays-outside";
export const CONTAINER_PATH = "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function writeIfChanged(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, file);
}

const safeName = (name: string) => { if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error("invalid agent name"); return name; };
const yamlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The DSH application patch: the official ACP row is replaced by ash's control plugin (ACP plus steer and inject),
 * and DSH's own sandbox is off (DSH_PERMISSION_MODE) because the container is the sandbox.
 */
export function patchText(pluginPath: string, model: { provider: string; model: string }, skillsPath?: string): string {
  return [
    "- id: acp",
    "  disabled: true",
    "- insert:",
    "    - id: ash-control",
    `      name: ${yamlString(pluginPath)}`,
    "      inject: [acpAppStartup]",
    "      config:",
    `        provider: ${yamlString(model.provider)}`,
    `        model: ${yamlString(model.model)}`,
    ...(skillsPath ? ["    - id: ash-skills", `      name: ${yamlString(skillsPath)}`] : []),
    "",
  ].join("\n");
}

export const DEFAULT_MODEL = { provider: "deepseek-official", model: "deepseek-v4-flash" } as const;

/** Prepare the files the runtime reads at start (patch, resolv.conf) and return how to spawn it. */
export function prepareLaunch(config: ContainerConfig, egressBase: string, stateDir: string): LaunchSpec {
  const model = config.model ?? DEFAULT_MODEL;
  const proxyless = "127.0.0.1,localhost,::1";
  const extra = { ...(config.env ?? {}) };
  const noProxy = [extra.NO_PROXY ?? extra.no_proxy, proxyless].filter(Boolean).join(",");
  const common: Record<string, string> = {
    ...extra,
    NO_PROXY: noProxy, no_proxy: noProxy,
    DSH_TELEMETRY_DISABLED: "1",
    // DSH's own sandbox and approval prompts are off as a pair: the container is the sandbox.
    DSH_PERMISSION_MODE: "danger-full-access",
    DEEPSEEK_API_KEY: PLACEHOLDER_KEY,
    DEEPSEEK_BASE_URL: egressBase,
    LANG: "C.UTF-8",
  };
  if (config.direct) {
    const { dshBin, dshHome, workspace, pluginPath } = config.direct;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dshHome, { recursive: true });
    const patch = join(stateDir, "container-patch.yml");
    const skills = join(dirname(dirname(pluginPath)), "ash-skills", "index.mjs");
    writeIfChanged(patch, patchText(pluginPath, model, existsSync(skills) ? skills : undefined));
    return {
      mode: "direct", command: dshBin, args: ["--profile", "acp", "--patch", patch],
      env: { HOME: process.env.HOME ?? dshHome, PATH: process.env.PATH ?? CONTAINER_PATH, DSH_HOME: dshHome, ...common },
      hostWorkspace: workspace, agentWorkspace: workspace, toAgentPath: (path) => path,
      agentHome: (name) => { const home = join(dirname(workspace), "agents", safeName(name)); mkdirSync(home, { recursive: true }); return { host: home, agent: home }; },
    };
  }
  const root = config.root;
  const rootfs = join(root, "ubuntu");
  const proot = join(root, "proot", "bin", "proot");
  if (!existsSync(proot) || !existsSync(join(rootfs, "opt", "dsh"))) throw new Error("agent container is not installed");
  const hostWorkspace = join(rootfs, "root", "work");
  mkdirSync(hostWorkspace, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeIfChanged(join(rootfs, "opt", "ash", "patch.yml"), patchText("/opt/ash/dsh-ash-control/index.mjs", model,
    existsSync(join(rootfs, "opt", "ash", "ash-skills", "index.mjs")) ? "/opt/ash/ash-skills/index.mjs" : undefined));
  const dns = (config.dns ?? []).filter((server) => /^[0-9a-fA-F:.]{2,45}$/.test(server));
  writeIfChanged(join(rootfs, "etc", "resolv.conf"), `${(dns.length ? dns : ["223.5.5.5", "119.29.29.29"]).map((server) => `nameserver ${server}`).join("\n")}\n`);
  const inside: Record<string, string> = { HOME: "/root", DSH_HOME: "/root/.dsh", PATH: CONTAINER_PATH, TMPDIR: "/tmp", TERM: "dumb", ...common };
  const run = inContainer(root, ["/opt/dsh/node_modules/.bin/dsh", "--profile", "acp", "--patch", "/opt/ash/patch.yml"], inside);
  return {
    mode: "proot", command: run.command, args: run.args, env: run.env,
    hostWorkspace, agentWorkspace: "/root/work",
    agentHome: (name) => { const home = join(rootfs, "root", "agents", safeName(name)); mkdirSync(home, { recursive: true }); return { host: home, agent: `/root/agents/${safeName(name)}` }; },
    toAgentPath: (path) => {
      if (path !== hostWorkspace && !path.startsWith(`${hostWorkspace}/`)) throw new Error("path is outside the agent workspace");
      return `/root/work${path.slice(hostWorkspace.length)}`;
    },
  };
}

/** The phone's shared storage (photos, downloads, documents) as Android mounts it for the app. */
export const SHARED_STORAGE = "/storage/emulated/0";

/**
 * The phone's shared storage inside the container, at /sdcard and at its own path (so paths the phone reports work
 * as they are). Bound whenever it exists: whether the agent may read it is Android's storage permission, checked on
 * every access, so a permission the owner grants later works without restarting the container.
 */
export function storageBinds(storage: string | null = existsSync(SHARED_STORAGE) ? SHARED_STORAGE : null): string[] {
  return storage ? ["-b", `${storage}:/sdcard`, "-b", `${storage}:${SHARED_STORAGE}`] : [];
}

/** A command run inside the container with exactly the given environment, as the agent's own processes are. */
export function inContainer(root: string, argv: string[], inside: Record<string, string>, storage?: string | null): { command: string; args: string[]; env: Record<string, string> } {
  const vars = Object.entries(inside).map(([key, value]) => `${key}=${value}`);
  return {
    command: join(root, "proot", "bin", "proot"),
    args: ["--kill-on-exit", "--link2symlink", "-0", "-r", join(root, "ubuntu"), "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", `${join(root, "tmp")}:/tmp`,
      ...(storage === undefined ? storageBinds() : storageBinds(storage)), "-w", "/root/work", "/usr/bin/env", "-i", ...vars, ...argv],
    env: { LD_LIBRARY_PATH: join(root, "proot", "lib"), PROOT_LOADER: join(root, "proot", "libexec", "loader"), PROOT_TMP_DIR: join(root, "tmp"),
      PATH: process.env.PATH ?? "/system/bin" },
  };
}

/** Python is part of the promise of a working Linux box. The image does not carry it, so it is installed once per image. */
export const PROVISION_SCRIPT = "command -v python3 >/dev/null && exit 0; " +
  "apt-get -o DPkg::Lock::Timeout=300 update -q && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q python3 python3-pip python3-venv";

export function provisionCommand(config: ContainerConfig): { command: string; args: string[]; env: Record<string, string> } | null {
  if (config.direct || !existsSync(join(config.root, "ubuntu", "usr", "bin", "apt-get"))) return null;
  if (existsSync(join(config.root, "ubuntu", "usr", "bin", "python3"))) return null;
  const extra = config.env ?? {};
  return inContainer(config.root, ["/bin/sh", "-c", PROVISION_SCRIPT],
    { HOME: "/root", PATH: CONTAINER_PATH, TMPDIR: "/tmp", TERM: "dumb", LANG: "C.UTF-8", ...extra });
}
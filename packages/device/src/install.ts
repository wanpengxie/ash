import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const DEVICE_VERSION = "0.1.0";
export const RELEASE_BASE = "https://github.com/wanpengxie/ash/releases/download";
export function releaseUrl(version: string, platform = process.platform, arch = process.arch): string {
  if (!/^v?\d+\.\d+\.\d+$/.test(version) || !["linux", "darwin"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported version or platform");
  return `${RELEASE_BASE}/device-v${version.replace(/^v/, "")}/ash-device-${platform}-${arch}.tar.gz`;
}
/** Download only an explicit official release, verify it, stage it, and switch an atomic symlink. */
export async function installRelease(root: string, version: string, sha256: string, dependencies: { fetch?: typeof fetch; check?: (dir: string) => Promise<void> } = {}): Promise<{ version: string; previous: string | null }> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("An approved SHA-256 is required");
  const url = releaseUrl(version), get = dependencies.fetch ?? fetch;
  await mkdir(join(root, "versions"), { recursive: true, mode: 0o700 });
  const staging = join(root, "versions", `${version.replace(/^v/, "")}-${randomUUID()}`); await mkdir(staging);
  const response = await get(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || Number(response.headers.get("content-length")) > 200 * 1024 * 1024) throw new Error("Release download failed");
  if (!response.body) throw new Error("Release body missing");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { bytes += chunk.byteLength; if (bytes > 200 * 1024 * 1024) throw new Error("Release is too large"); chunks.push(chunk); }
  const archive = Buffer.concat(chunks);
  if (createHash("sha256").update(archive).digest("hex") !== sha256) throw new Error("Release checksum mismatch; current installation unchanged");
  const file = join(staging, "release.tar.gz"); await writeFile(file, archive, { mode: 0o600 });
  const { stdout } = await exec("tar", ["-tzf", file], { maxBuffer: 1024 * 1024 });
  if (!stdout.trim() || stdout.trim().split("\n").some(name => !/^ash-device\//.test(name) || name.split("/").includes("..") || name.includes("\\"))) throw new Error("Invalid release paths");
  const listing = await exec("tar", ["-tvzf", file], { maxBuffer: 1024 * 1024 });
  if (listing.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) throw new Error("Release links and special files are not allowed");
  await exec("tar", ["-xzf", file, "--strip-components=1", "-C", staging]);
  for (const path of ["node", "ash-device.mjs", "bin/ash-device"]) if (!(await lstat(join(staging, path))).isFile()) throw new Error("Invalid release file");
  await chmod(join(staging, "node"), 0o755); await chmod(join(staging, "bin/ash-device"), 0o755);
  const manifest = JSON.parse(await readFile(join(staging, "release.json"), "utf8"));
  if (manifest.version !== version.replace(/^v/, "") || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Release manifest mismatch");
  if (dependencies.check) await dependencies.check(staging);
  else {
    const { stdout } = await exec(join(staging, "node"), [join(staging, "ash-device.mjs"), "--version"], { timeout: 15_000 });
    if (stdout.trim() !== manifest.version) throw new Error("Release startup check failed");
  }
  const current = join(root, "current"), previous = await readlink(current).catch(() => null);
  const next = join(root, `current-${randomUUID()}`); await symlink(resolve(staging), next); await rename(next, current);
  await writeFile(join(root, "installation.json"), JSON.stringify({ version: manifest.version, previous, installed_at: Date.now() }), { mode: 0o600 });
  return { version: manifest.version, previous };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unit = (value: string) => `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function serviceDefinition(root: string, platform: string, path: string): string {
  const command = join(root, "current", "bin", "ash-device"), config = join(root, "device.json");
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.ash.device</string><key>ProgramArguments</key><array><string>${xml(command)}</string><string>run</string><string>--config</string><string>${xml(config)}</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;
  if (platform !== "linux") throw new Error("Unsupported service platform");
  return `[Unit]\nDescription=Ash computer device\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${unit(command)} run --config ${unit(config)}\nEnvironment=${unit(`PATH=${path}`)}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=default.target\n`;
}

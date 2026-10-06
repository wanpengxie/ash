#!/usr/bin/env node
// Build the agent container shipped inside the APK: an arm64 Ubuntu root filesystem with node and
// DSH, plus the proot that runs it on the phone. Runs on an x86_64 Linux build machine; nothing in
// the result is executed here, so the build validates structure (architectures, required natives)
// and the phone is where it runs.
//
//   node tools/build-container-rootfs.mjs [--out build/container] [--cache ~/.cache/ash-container]
//                                         [--registry https://registry.npmmirror.com] [--keep-office]
//
// Result (build/container/):
//   ash-container-<VERSION>.tar.gz   top level: VERSION, proot/, ubuntu/ (tmp/ is created on the phone)
//   VERSION                          the same build id, read by the Android build
//
// Layout inside the archive:
//   proot/bin/proot, proot/lib/{libtalloc.so.2,libandroid-shmem.so}, proot/libexec/loader   (Termux aarch64)
//   ubuntu/                          ubuntu-base 24.04 arm64, plus
//     opt/node/                      node 22 linux-arm64
//     opt/dsh/                       `npm install @deepseek-ai/dsh` for linux-arm64 (glibc)
//     opt/ash/dsh-ash-control/       ash's DSH plugin (packages/dsh-ash-control)
//     opt/ash/ash-skills/            ash's skills plugin and persona templates (packages/ash-skills)
//     etc/apt/sources.list.d/ubuntu.sources, root/.config/pip/pip.conf, root/.npmrc   mirrors
//     etc/resolv.conf                placeholder; ash core rewrites it on every start
//     root/work/                     the agent workspace
//     root/.dsh/                     DSH_HOME
//
// VERSION = <dsh version>-<sha256 of the uncompressed proot/ + ubuntu/ archive, 12 hex>, so the phone
// re-extracts whenever any byte, link or mode differs. Hard links become plain files (app storage
// refuses hard links); symlinks and modes are kept; owners are numeric 0.
//
// Needs: node ≥ 22, npm, ar, GNU tar, xz, gzip (pigz is used when present).

import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAINER_PACKAGES, containerSourcesDigest } from "./container-sources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every download is pinned by sha256.
const INPUTS = {
  ubuntu: {
    version: "24.04.5",
    url: "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz",
    sha256: "a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2",
  },
  node: {
    version: "22.23.3",
    url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-arm64.tar.xz",
    sha256: "a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f",
  },
  termux: {
    repo: "https://packages.termux.dev/apt/termux-main",
    debs: {
      proot: { version: "5.1.107.96", file: "pool/main/p/proot/proot_5.1.107.96_aarch64.deb", sha256: "8199dca06dccb693ec09fb1759e3e1ad08b4863f0c11c612f89c20bd9ecdc1a0" },
      libtalloc: { version: "2.5.0", file: "pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb", sha256: "556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7" },
      "libandroid-shmem": { version: "0.7", file: "pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb", sha256: "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6" },
    },
  },
  dsh: { package: "@deepseek-ai/dsh", version: "0.2.0-rc.2" },
};

// arm64 natives DSH must carry (relative to opt/dsh/node_modules); a missing one fails the build.
const REQUIRED_NATIVES = [
  "@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node",
  "@koromix/koffi-linux-arm64/linux_arm64/koffi.node",
  "node-addon-require-builtin-linux-arm64-gnu/prebuilt/linux-arm64-gnu-napi-v9.node",
  "@img/sharp-linux-arm64/lib",
  "@img/sharp-libvips-linux-arm64/lib",
  "sherpa-onnx-linux-arm64/sherpa-onnx.node",
  "node-pty/prebuilds/linux-arm64/pty.node",
  "@vscode/ripgrep-linux-arm64/bin/rg",
];

const MIRRORS = {
  "etc/apt/sources.list.d/ubuntu.sources": `# Tsinghua mirror of ubuntu-ports (ports.ubuntu.com does not resolve on many networks).
# Plain http: ubuntu-base has no CA bundle yet; apt verifies every index with the archive key.
Types: deb
URIs: http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`,
  "root/.config/pip/pip.conf": `[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
`,
  "root/.npmrc": `registry=https://registry.npmmirror.com/
`,
  // Rewritten by ash core on every start with the phone's current DNS servers.
  "etc/resolv.conf": `nameserver 223.5.5.5
nameserver 119.29.29.29
`,
};

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (...a) => console.log("[container]", ...a);
const sh = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30, ...o });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function fetchVerified(url, sha, cacheDir) {
  const file = path.join(cacheDir, sha);
  if (fs.existsSync(file) && sha256(file) === sha) return file;
  log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha) throw new Error(`${url}: sha256 ${got} ≠ pinned ${sha}`);
  fs.writeFileSync(file, buf);
  return file;
}

function extractDeb(deb, dest) {
  const members = sh("ar", ["t", deb]).toString().split("\n").filter(Boolean);
  const data = members.find((m) => m.startsWith("data.tar"));
  if (!data) throw new Error(`${deb}: no data.tar`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ash-deb-"));
  sh("ar", ["x", deb, data], { cwd: tmp });
  fs.mkdirSync(dest, { recursive: true });
  sh("tar", ["-xf", path.join(tmp, data), "-C", dest]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function* walk(dir, rel = "") {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    yield [r, e];
    if (e.isDirectory()) yield* walk(dir, r);
  }
}

/** Machine of a binary: "aarch64", "x86-64", "elf:<n>", "mach-o", "pe", or null for anything else. */
function binaryKind(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(20);
  const n = fs.readSync(fd, b, 0, 20, 0);
  fs.closeSync(fd);
  if (n >= 20 && b.readUInt32BE(0) === 0x7f454c46) {
    const m = b[5] === 2 ? b.readUInt16BE(18) : b.readUInt16LE(18);
    return m === 183 ? "aarch64" : m === 62 ? "x86-64" : `elf:${m}`;
  }
  if (n >= 4 && [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(b.readUInt32BE(0))) return "mach-o";
  if (n >= 2 && b[0] === 0x4d && b[1] === 0x5a && /\.(node|dll|exe)$/i.test(file)) return "pe";
  return null;
}

function duBytes(dir) {
  let total = 0;
  for (const [rel, e] of walk(dir)) if (e.isFile()) total += fs.lstatSync(path.join(dir, rel)).size;
  return total;
}

async function build() {
  process.umask(0o022); // files ash adds get the same modes on every build machine
  const out = path.resolve(opt("--out", path.join(ROOT, "build/container")));
  const cache = path.resolve(opt("--cache", path.join(os.homedir(), ".cache/ash-container")));
  const registry = opt("--registry", process.env.ASH_NPM_REGISTRY ?? "https://registry.npmjs.org/");
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const work = path.join(out, "work");
  fs.rmSync(work, { recursive: true, force: true });
  const proot = path.join(work, "proot");
  const ubuntu = path.join(work, "ubuntu");
  fs.mkdirSync(ubuntu, { recursive: true });

  // 1. Ubuntu base. -p keeps the published modes (setuid bits, /root 0700, /tmp 1777).
  const ub = await fetchVerified(INPUTS.ubuntu.url, INPUTS.ubuntu.sha256, cache);
  sh("tar", ["-xpzf", ub, "-C", ubuntu]);
  log("ubuntu-base", INPUTS.ubuntu.version);

  // 2. node for linux-arm64 in /opt/node.
  const nodeTar = await fetchVerified(INPUTS.node.url, INPUTS.node.sha256, cache);
  fs.mkdirSync(path.join(ubuntu, "opt/node"), { recursive: true });
  sh("tar", ["-xpJf", nodeTar, "-C", path.join(ubuntu, "opt/node"), "--strip-components=1"]);
  log("node", INPUTS.node.version);

  // 3. proot from Termux, as published (started with LD_LIBRARY_PATH=proot/lib and PROOT_LOADER).
  const debs = path.join(out, "debs");
  fs.rmSync(debs, { recursive: true, force: true });
  for (const [name, d] of Object.entries(INPUTS.termux.debs)) {
    extractDeb(await fetchVerified(`${INPUTS.termux.repo}/${d.file}`, d.sha256, cache), debs);
    log("termux", name, d.version);
  }
  const usr = path.join(debs, "data/data/com.termux/files/usr");
  const prootFiles = {
    "bin/proot": "bin/proot",
    "lib/libtalloc.so.2": "lib/libtalloc.so.2", // a symlink to libtalloc.so.2.x in the deb; shipped as the file itself
    "lib/libandroid-shmem.so": "lib/libandroid-shmem.so",
    "libexec/loader": "libexec/proot/loader",
  };
  for (const [to, from] of Object.entries(prootFiles)) {
    const dst = path.join(proot, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(fs.realpathSync(path.join(usr, from)), dst);
    fs.chmodSync(dst, 0o755);
    if (binaryKind(dst) !== "aarch64") throw new Error(`proot/${to} is not an aarch64 ELF`);
  }
  for (const d of ["", "bin", "lib", "libexec"]) fs.chmodSync(path.join(proot, d), 0o755);
  fs.rmSync(debs, { recursive: true, force: true });

  // 4. DSH for linux-arm64 (glibc). Install scripts are skipped: they would run x64 node here.
  //    What they do on arm64 is replayed below (node-pty/koffi only probe their prebuilds; the
  //    subprocess helper restores the spawn-helper exec bit).
  const dsh = path.join(ubuntu, "opt/dsh");
  const spec = `${INPUTS.dsh.package}@${INPUTS.dsh.version}`;
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), "ash-container-npm-"));
  log("npm install", spec, "for linux-arm64 from", registry);
  sh(
    "npm",
    ["install", "--prefix", dsh, spec, "--os=linux", "--cpu=arm64", "--libc=glibc", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--update-notifier=false", `--registry=${registry}`, `--cache=${npmCache}`],
    { stdio: "inherit" },
  );
  fs.rmSync(npmCache, { recursive: true, force: true });
  const nm = path.join(dsh, "node_modules");
  const helper = path.join(nm, "node-pty/prebuilds/linux-arm64/spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);

  // Prune what can never run in this container.
  const prune = [];
  for (const d of fs.readdirSync(path.join(nm, "node-pty/prebuilds"))) if (d !== "linux-arm64") prune.push(`node-pty/prebuilds/${d}`);
  prune.push("node-pty/third_party"); // Windows conpty
  // The office converter's 145 MB WebAssembly engine: loaded only when an Office document is
  // converted (DSH starts without it); the agent can `npm install` it later. --keep-office keeps it.
  if (!flag("--keep-office")) prune.push("@deepseek-ai/libreoffice-kit-wasm");
  for (const p of prune) {
    const abs = path.join(nm, p);
    if (!fs.existsSync(abs)) continue;
    const size = fs.statSync(abs).isDirectory() ? duBytes(abs) : fs.statSync(abs).size;
    fs.rmSync(abs, { recursive: true, force: true });
    log("pruned", p, mb(size));
  }
  verifyDsh(nm, prune);

  // 5. ash's DSH plugins: the ACP control bridge and ash's own skills (+ persona templates).
  for (const pkg of CONTAINER_PACKAGES) {
    fs.cpSync(path.join(ROOT, "packages", pkg), path.join(ubuntu, "opt/ash", pkg), { recursive: true });
  }

  // 6. Mirrors, DNS placeholder, workspace and DSH home.
  for (const [rel, body] of Object.entries(MIRRORS)) {
    const f = path.join(ubuntu, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.rmSync(f, { force: true }); // may be a symlink in the base image
    fs.writeFileSync(f, body, { mode: 0o644 });
  }
  for (const d of ["root/work", "root/.dsh"]) fs.mkdirSync(path.join(ubuntu, d), { recursive: true, mode: 0o755 });

  validate(work);

  // 7. Archive. The id is the uncompressed archive of proot/ + ubuntu/ in a fixed order with clamped
  //    times and numeric owners, so the same inputs give the same VERSION.
  const tarFlags = ["--sort=name", "--format=gnu", "--numeric-owner", "--owner=0", "--group=0", "--mtime=@1767225600", "--clamp-mtime", "--hard-dereference"];
  const { digest, bytes: uncompressed } = await hashTar(["-c", ...tarFlags, "-C", work, "proot", "ubuntu"]);
  const version = `${INPUTS.dsh.version}-${digest.slice(0, 12)}`;
  fs.writeFileSync(path.join(work, "VERSION"), version + "\n");

  const name = `ash-container-${version}.tar.gz`;
  const tmpOut = path.join(out, `${name}.partial`);
  const gz = spawnSync("which", ["pigz"]).status === 0 ? "pigz -9 -n" : "gzip -9 -n";
  sh("sh", ["-c", `tar -c ${tarFlags.join(" ")} -C "$1" VERSION proot ubuntu | ${gz} > "$2"`, "sh", work, tmpOut], { stdio: "inherit" });
  for (const f of fs.readdirSync(out)) if (/^ash-container-.*\.tar\.gz$/.test(f)) fs.rmSync(path.join(out, f));
  fs.renameSync(tmpOut, path.join(out, name));
  fs.writeFileSync(path.join(out, "VERSION"), version + "\n");
  // What the carried ash packages were when this container was built (checked before the APK is built).
  fs.writeFileSync(path.join(out, "SOURCES"), containerSourcesDigest(ROOT) + "\n");
  const compressed = fs.statSync(path.join(out, name)).size;
  const dshBytes = duBytes(dsh);
  if (!flag("--keep-work")) fs.rmSync(work, { recursive: true, force: true });
  log(`done: ${path.join(out, name)}`);
  log(`  VERSION ${version}`);
  log(`  uncompressed ${mb(uncompressed)} (of which /opt/dsh ${mb(dshBytes)}), compressed ${mb(compressed)}`);
}

/** sha256 and length of a tar stream, without holding it in memory. */
function hashTar(argv) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    let bytes = 0;
    const p = spawn("tar", argv, { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d) => {
      h.update(d);
      bytes += d.length;
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve({ digest: h.digest("hex"), bytes }) : reject(new Error(`tar exited ${code}`))));
  });
}

/** Every arm64 native DSH needs is there, and nothing native for another machine is left. */
function verifyDsh(nm, pruned) {
  const missing = REQUIRED_NATIVES.filter((p) => !fs.existsSync(path.join(nm, p)));
  if (missing.length) throw new Error(`DSH arm64 natives missing:\n  ${missing.join("\n  ")}`);
  // Optional platform packages npm should have picked for linux-arm64-glibc.
  const lock = JSON.parse(fs.readFileSync(path.join(nm, ".package-lock.json"), "utf8"));
  const absent = [];
  for (const [p, meta] of Object.entries(lock.packages ?? {})) {
    if (!meta.os && !meta.cpu) continue;
    if (pruned.some((x) => p === `node_modules/${x}`)) continue;
    const ok = (list, v) => !list || list.includes(v) || (list.some((x) => x.startsWith("!")) && !list.includes(`!${v}`));
    if (ok(meta.os, "linux") && ok(meta.cpu, "arm64") && ok(meta.libc, "glibc") && !fs.existsSync(path.join(nm, "..", p))) absent.push(p);
  }
  if (absent.length) throw new Error(`platform packages for linux-arm64 not installed:\n  ${absent.join("\n  ")}`);
  const foreign = [];
  let natives = 0;
  for (const [rel, e] of walk(nm)) {
    if (!e.isFile()) continue;
    const kind = binaryKind(path.join(nm, rel));
    if (kind === "aarch64") natives++;
    else if (kind) foreign.push(`${rel} (${kind})`);
  }
  if (foreign.length) throw new Error(`DSH carries natives for other machines:\n  ${foreign.join("\n  ")}`);
  if (!fs.existsSync(path.join(nm, ".bin/dsh"))) throw new Error("opt/dsh/node_modules/.bin/dsh missing");
  log(`DSH natives: ${natives} aarch64 binaries, none for other machines`);
}

/** The contract layout, checked before archiving. */
function validate(work) {
  const need = [
    "proot/bin/proot",
    "proot/lib/libtalloc.so.2",
    "proot/lib/libandroid-shmem.so",
    "proot/libexec/loader",
    "ubuntu/etc/os-release",
    "ubuntu/usr/bin/env",
    "ubuntu/bin",
    "ubuntu/opt/node/bin/node",
    "ubuntu/opt/node/bin/npm",
    "ubuntu/opt/dsh/node_modules/.bin/dsh",
    "ubuntu/opt/ash/dsh-ash-control/index.mjs",
    "ubuntu/opt/ash/dsh-ash-control/package.json",
    "ubuntu/opt/ash/ash-skills/index.mjs",
    "ubuntu/opt/ash/ash-skills/skills",
    "ubuntu/opt/ash/ash-skills/persona",
    "ubuntu/etc/apt/sources.list.d/ubuntu.sources",
    "ubuntu/root/.config/pip/pip.conf",
    "ubuntu/root/.npmrc",
    "ubuntu/root/work",
    "ubuntu/root/.dsh",
    "ubuntu/etc/resolv.conf",
  ];
  const missing = need.filter((p) => {
    try {
      fs.lstatSync(path.join(work, p));
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error(`container layout incomplete:\n  ${missing.join("\n  ")}`);
  if (binaryKind(path.join(work, "ubuntu/opt/node/bin/node")) !== "aarch64") throw new Error("opt/node/bin/node is not aarch64");
  if (!/VERSION_ID="24\.04"/.test(fs.readFileSync(path.join(work, "ubuntu/etc/os-release"), "utf8"))) throw new Error("ubuntu is not 24.04");
  if (fs.lstatSync(path.join(work, "ubuntu/etc/resolv.conf")).isSymbolicLink()) throw new Error("etc/resolv.conf must be a plain file");
  for (const x of ["proot/bin/proot", "proot/libexec/loader", "ubuntu/opt/node/bin/node"]) {
    if (!(fs.statSync(path.join(work, x)).mode & 0o100)) throw new Error(`${x} is not executable`);
  }
  // The dsh launcher resolves to a node script inside the tree.
  const bin = fs.realpathSync(path.join(work, "ubuntu/opt/dsh/node_modules/.bin/dsh"));
  if (!bin.startsWith(path.join(work, "ubuntu/opt/dsh/"))) throw new Error(`.bin/dsh points outside opt/dsh: ${bin}`);
  if (!(fs.statSync(bin).mode & 0o100)) throw new Error(".bin/dsh target is not executable");
  // Absolute symlinks are fine (proot resolves them inside the guest); links must not escape upward.
  for (const [rel, e] of walk(work)) {
    if (!e.isSymbolicLink()) continue;
    const t = fs.readlinkSync(path.join(work, rel));
    if (t.startsWith("/")) continue;
    const top = rel.split("/")[0];
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), t));
    if (resolved.startsWith("..") || resolved.split("/")[0] !== top) throw new Error(`symlink escapes its tree: ${rel} -> ${t}`);
  }
  log("layout ok");
}

await build();

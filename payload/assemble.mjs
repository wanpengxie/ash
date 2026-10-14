#!/usr/bin/env node
// Assemble the ash payload (everything the phone runs besides the Android host) from locked inputs.
//
//   node payload/assemble.mjs --lock            resolve payload/manifest.json roots → pin versions + sha256
//   node payload/assemble.mjs --out build/payload [--cache ~/.cache/ash-payload]
//
// Layout of the result (extracted by the host into files/payload/):
//   runtime/   Termux aarch64 packages (node, python, git, rg, bash, curl, pnpm …), made relocatable:
//              RUNPATH=$ORIGIN/…/lib on every ELF (no LD_LIBRARY_PATH needed), Termux prefix in
//              shebangs replaced by the @PAYLOAD@ placeholder that the host fills in on extraction.
//   ash/       ash core bundle (ash-core.mjs), libashnodump.so, android-node-compat/ (the preload the host starts core with).
//   ash-skills/  ash's skills, persona templates and agent templates (the hub reads them; the container carries its own copy as a DSH plugin).
//   ash-apps/    first-party apps (packages/apps), one folder each: app.json, a bundled server.mjs, the icon.
// DSH is not here: it runs in the agent container (tools/build-container-rootfs.mjs).
// Next to the zip: payload-index.json { build, links, exec, placeholders }.
//
// Needs: node ≥ 22, npm, ar, tar (xz/zstd), zip, patchelf (PATCHELF=… to override).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBundledApps } from "../packages/apps/bundle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MANIFEST = path.join(HERE, "manifest.json");
const TERMUX_PREFIX = "data/data/com.termux/files/usr";
const PLACEHOLDER = "@PAYLOAD@";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (...a) => console.log("[payload]", ...a);
const sh = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30, ...o });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// ------------------------------------------------------------------ Termux index & lock

function parsePackages(text) {
  const out = {};
  for (const block of text.split(/\n\n+/)) {
    const p = {};
    for (const line of block.split("\n")) {
      if (!line || line[0] === " ") continue;
      const i = line.indexOf(": ");
      if (i > 0) p[line.slice(0, i)] = line.slice(i + 2);
    }
    if (p.Package) out[p.Package] = p;
  }
  return out;
}

function depsOf(p) {
  return (p.Depends ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.split("|")[0].trim().replace(/\s*\(.*\)$/, ""));
}

async function lock() {
  const t = manifest.termux;
  const url = `${t.repo}/dists/stable/main/binary-${t.arch}/Packages`;
  log("index", url);
  const index = parsePackages(await (await fetch(url)).text());
  const locked = {};
  const stack = [...t.roots];
  while (stack.length) {
    const name = stack.pop();
    if (locked[name] || t.exclude.includes(name)) continue;
    const p = index[name];
    if (!p) throw new Error(`termux package not found: ${name}`);
    locked[name] = { version: p.Version, file: p.Filename, sha256: p.SHA256 };
    stack.push(...depsOf(p));
  }
  t.lock = Object.fromEntries(Object.entries(locked).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  log(`locked ${Object.keys(locked).length} termux packages`);
}

// ------------------------------------------------------------------ fetch & extract

async function fetchVerified(url, sha, cacheDir) {
  const file = path.join(cacheDir, sha);
  if (fs.existsSync(file) && sha256(file) === sha) return file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha) throw new Error(`${url}: sha256 ${got} ≠ locked ${sha}`);
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

// ------------------------------------------------------------------ tree helpers

function* walk(dir, rel = "") {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    yield [r, e];
    if (e.isDirectory()) yield* walk(dir, r);
  }
}

const isElf = (file) => {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  return b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
};

function firstLine(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(256);
  const n = fs.readSync(fd, b, 0, 256, 0);
  fs.closeSync(fd);
  const s = b.subarray(0, n).toString("latin1");
  return s.startsWith("#!") ? s.split("\n")[0] : null;
}

// ------------------------------------------------------------------ assemble

async function build() {
  const out = path.resolve(opt("--out", path.join(ROOT, "build/payload")));
  const cache = path.resolve(opt("--cache", path.join(os.homedir(), ".cache/ash-payload")));
  const patchelf = process.env.PATCHELF ?? "patchelf";
  // Without patchelf every binary would keep Termux's RUNPATH and nothing would start on the phone.
  try {
    sh(patchelf, ["--version"]);
  } catch {
    throw new Error(`patchelf not found (${patchelf}); install it or set PATCHELF=…`);
  }
  fs.mkdirSync(cache, { recursive: true });
  fs.rmSync(out, { recursive: true, force: true });
  const tree = path.join(out, "tree");
  const runtime = path.join(tree, "runtime");
  fs.mkdirSync(runtime, { recursive: true });

  // 1. Termux packages → runtime/
  const t = manifest.termux;
  if (!t.lock) throw new Error("manifest has no termux lock; run --lock first");
  const staging = path.join(out, "staging");
  for (const [name, p] of Object.entries(t.lock)) {
    const deb = await fetchVerified(`${t.repo}/${p.file}`, p.sha256, cache);
    extractDeb(deb, staging);
    log("termux", name, p.version);
  }
  const usr = path.join(staging, TERMUX_PREFIX);
  const drop = t.drop.map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$"));
  const links = [];
  const exec = [];
  const placeholders = [];
  for (const [rel, e] of walk(usr)) {
    if (drop.some((r) => r.test(rel))) continue;
    const src = path.join(usr, rel);
    const dst = path.join(runtime, rel);
    if (e.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      continue;
    }
    if (e.isSymbolicLink()) {
      let target = fs.readlinkSync(src);
      if (target.startsWith("/" + TERMUX_PREFIX + "/")) target = path.posix.relative(path.posix.dirname("/" + TERMUX_PREFIX + "/" + rel), target);
      links.push([`runtime/${rel}`, target]);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const mode = fs.statSync(src).mode;
    if (isElf(dst)) {
      // RUNPATH relative to the file, so no LD_LIBRARY_PATH is needed anywhere (bionic expands $ORIGIN).
      const lib = path.posix.relative(path.posix.dirname(`/${rel}`), "/lib") || ".";
      try {
        sh(patchelf, ["--set-rpath", lib === "." ? "$ORIGIN" : `$ORIGIN/${lib}`, dst]);
      } catch {
        /* objects without a dynamic section (e.g. static helpers) keep their layout */
      }
      if (mode & 0o111 || /\.so(\.|$)/.test(rel)) exec.push(`runtime/${rel}`);
      continue;
    }
    const shebang = firstLine(dst);
    if (shebang) {
      exec.push(`runtime/${rel}`);
      if (shebang.includes("/" + TERMUX_PREFIX)) {
        const body = fs.readFileSync(dst, "latin1");
        fs.writeFileSync(dst, body.replace(shebang, shebang.replaceAll("/" + TERMUX_PREFIX, `${PLACEHOLDER}/runtime`)), "latin1");
        placeholders.push(`runtime/${rel}`);
      }
    } else if (mode & 0o111) exec.push(`runtime/${rel}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });

  // Pure-JS tools installed from npm into the runtime prefix (pnpm: Termux ships it as a single
  // executable that must not be touched by patchelf, the npm package is plain JS).
  for (const [name, version] of Object.entries(manifest.runtimeNpm ?? {})) {
    sh("npm", ["install", "-g", "--prefix", runtime, `${name}@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { stdio: "inherit" });
    log("runtime npm", name, version);
  }
  for (const e of fs.readdirSync(path.join(runtime, "bin"), { withFileTypes: true })) {
    if (e.isSymbolicLink()) links.push([`runtime/bin/${e.name}`, fs.readlinkSync(path.join(runtime, "bin", e.name))]);
  }

  // Extra files the runtime needs (locked by sha256), e.g. the wheel ensurepip/venv expect.
  for (const f of manifest.runtimeFiles ?? []) {
    const file = await fetchVerified(f.url, f.sha256, cache);
    fs.mkdirSync(path.dirname(path.join(tree, f.path)), { recursive: true });
    fs.copyFileSync(file, path.join(tree, f.path));
    log("runtime file", f.path);
  }
  // Patches to the runtime: each replaces one file whose original must match its
  // sha256 — an upstream change stops the build instead of silently losing the fix.
  for (const pt of manifest.runtimePatches ?? []) {
    const target = path.join(tree, pt.path);
    const got = sha256(target);
    if (got !== pt.sha256) throw new Error(`runtime patch ${pt.path}: original sha256 ${got} ≠ expected ${pt.sha256} (the package changed; review ${pt.with})`);
    fs.copyFileSync(path.join(HERE, pt.with), target);
    log("runtime patch", pt.path);
  }

  // JS entry points whose shebang is `#!/usr/bin/env node` (npm, npx, corepack, pnpm …) become sh wrappers:
  // Android has no /usr/bin/env.
  for (let i = links.length - 1; i >= 0; i--) {
    const [from, target] = links[i];
    if (!from.startsWith("runtime/bin/")) continue;
    const resolved = path.join(tree, path.dirname(from), target);
    if (!fs.existsSync(resolved) || isElf(resolved)) continue;
    const line = firstLine(resolved) ?? "";
    if (!/env node|bin\/node/.test(line)) continue;
    const rel = path.posix.relative("runtime", path.posix.join(path.posix.dirname(from), target));
    fs.rmSync(path.join(tree, from), { force: true });
    fs.writeFileSync(path.join(tree, from), `#!/system/bin/sh\nexec "${PLACEHOLDER}/runtime/bin/node" "${PLACEHOLDER}/runtime/${rel}" "$@"\n`);
    placeholders.push(from);
    exec.push(from);
    links.splice(i, 1);
  }

  // 2. ash core.
  const core = path.join(ROOT, "packages/core/dist/ash-core.mjs");
  if (!fs.existsSync(core)) throw new Error("build ash core first: npm run build:core");
  fs.mkdirSync(path.join(tree, "ash"), { recursive: true });
  fs.copyFileSync(core, path.join(tree, "ash/ash-core.mjs"));
  // Core marks itself non-dumpable with this library, so the agent container (same Linux user) cannot read its memory.
  fs.copyFileSync(buildNodump(), path.join(tree, "ash/libashnodump.so"));

  // The preload the host starts core with (--require): hard links and flock where the app sandbox refuses them.
  fs.cpSync(path.join(ROOT, "packages/android-compat/packages/android-node-compat"), path.join(tree, "ash/android-node-compat"), { recursive: true });

  // Ash's skills, persona and agent templates, read by the hub. Their tests stay in the repository: only the plugin, the skills (with their sample files) and the persona templates ship.
  fs.cpSync(path.join(ROOT, "packages/ash-skills"), path.join(tree, "ash-skills"), { recursive: true,
    filter: (source) => path.relative(path.join(ROOT, "packages/ash-skills"), source).split(path.sep)[0] !== "test" });
  // First-party apps (packages/apps/<id>) as single-file apps, beside ash-skills: the hub installs the ones the phone does not have yet as built-in apps.
  const apps = await writeBundledApps(path.join(ROOT, "packages/apps"), path.join(tree, "ash-apps"));
  log("first-party apps", apps.join(", "));
  // 3. symlinks and zip; the index tells the host what to recreate.
  for (const [from] of links) fs.rmSync(path.join(tree, from), { force: true });
  for (const [rel, e] of walk(tree)) if (e.isSymbolicLink()) {
    if (!links.some(([from]) => from === rel)) links.push([rel, fs.readlinkSync(path.join(tree, rel))]);
    fs.rmSync(path.join(tree, rel));
  }
  // The build id is the tree itself (every path and byte, links, modes), so the phone reinstalls
  // whenever anything in it differs — also a fix in how the tree is made, not only new inputs.
  const all = [...walk(tree)].sort(([a], [b]) => (a < b ? -1 : 1));
  const h = createHash("sha256").update(JSON.stringify({ links, exec: [...new Set(exec)].sort(), placeholders: [...new Set(placeholders)].sort() }));
  for (const [rel, e] of all) h.update(rel + "\0").update(e.isFile() ? fs.readFileSync(path.join(tree, rel)) : "dir").update("\0");
  const inputs = h.digest("hex").slice(0, 16);
  const entries = all.length + 1;
  const index = { schema: 1, build: `${version}-${inputs}`, entries, links, exec: [...new Set(exec)].sort(), placeholders: [...new Set(placeholders)].sort(), placeholder: PLACEHOLDER };
  fs.writeFileSync(path.join(tree, "payload-index.json"), JSON.stringify(index));
  fs.rmSync(path.join(out, "payload.zip"), { force: true });
  sh("zip", ["-q", "-r", "-X", "-9", path.join(out, "payload.zip"), "."], { cwd: tree });
  fs.copyFileSync(path.join(tree, "payload-index.json"), path.join(out, "payload-index.json"));
  const size = (fs.statSync(path.join(out, "payload.zip")).size / 1e6).toFixed(1);
  log(`done: ${out}/payload.zip (${size} MB), build ${index.build}, ${links.length} links, ${index.exec.length} executables`);
}

if (flag("--lock")) await lock();
else await build();

/** Compile packages/core/native/nodump.c for the phone with the Android NDK. The payload is not built without it. */
function buildNodump() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), "android-sdk");
  const ndkRoot = process.env.ANDROID_NDK_HOME ?? (() => {
    const dir = path.join(sdk, "ndk");
    const versions = fs.existsSync(dir) ? fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    return versions.length ? path.join(dir, versions.at(-1)) : null;
  })();
  if (!ndkRoot) throw new Error("the Android NDK is required to build libashnodump.so (set ANDROID_NDK_HOME)");
  const host = fs.readdirSync(path.join(ndkRoot, "toolchains/llvm/prebuilt"))[0];
  const clang = path.join(ndkRoot, "toolchains/llvm/prebuilt", host, "bin/aarch64-linux-android24-clang");
  const out = path.join(ROOT, "build/libashnodump.so");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  sh(clang, ["-shared", "-fPIC", "-O2", "-Wl,-z,max-page-size=16384", "-o", out, path.join(ROOT, "packages/core/native/nodump.c")]);
  log("libashnodump.so built with", path.basename(ndkRoot));
  return out;
}

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
//   dsh/       `npm install -g @deepseek-ai/dsh@<version>` for android-arm64, byte-for-byte as published,
//              plus android-compat packages as siblings in dsh/lib/node_modules (never inside @deepseek-ai).
//   ash/       ash core bundle.
//   bin/       small sh wrappers (Android has no /usr/bin/env).
//   profile/   the host's DSH patch layer (cordis.patch.yml rows, e.g. the ptc worker launcher).
// Next to the zip: payload-index.json { build, links, exec, placeholders, dshTree }.
//
// Needs: node ≥ 22, npm, ar, tar (xz/zstd), zip, patchelf (PATCHELF=… to override).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  // Patches to the runtime (never to DSH): each replaces one file whose original must match its
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

  // 2. DSH, as published, for android-arm64.
  const dsh = path.join(tree, "dsh");
  const spec = `${manifest.dsh.package}@${manifest.dsh.version}`;
  log("npm install", spec);
  sh("npm", ["install", "-g", "--prefix", dsh, spec, "--os=android", "--cpu=arm64", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { stdio: "inherit" });
  fs.rmSync(path.join(dsh, "bin"), { recursive: true, force: true }); // symlinks into lib/; the host starts DSH through ash core
  const dshTree = hashTree(path.join(dsh, "lib/node_modules", manifest.dsh.package));

  // 3. android-compat packages next to DSH (Node's resolution walks up to dsh/lib/node_modules).
  const compatSrc = path.join(ROOT, "packages/android-compat/packages");
  for (const name of fs.existsSync(compatSrc) ? fs.readdirSync(compatSrc) : []) {
    const dir = name.startsWith("@") ? fs.readdirSync(path.join(compatSrc, name)).map((n) => `${name}/${n}`) : [name];
    for (const pkg of dir) {
      fs.cpSync(path.join(compatSrc, pkg), path.join(dsh, "lib/node_modules", pkg), { recursive: true, verbatimSymlinks: true });
      log("compat", pkg);
    }
  }
  for (const [name, version] of Object.entries(manifest.compatNpm ?? {})) {
    // Official pure-JS / wasm fallbacks (e.g. @img/sharp-wasm32), installed beside DSH.
    sh("npm", ["install", "--prefix", path.join(out, "npm-extra"), `${name}@${version}`, "--force", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--loglevel=error"], { stdio: "inherit" });
    for (const [rel, e] of walk(path.join(out, "npm-extra/node_modules"))) {
      if (!e.isDirectory() || rel.startsWith(".") || rel.split("/").length !== (rel.startsWith("@") ? 2 : 1)) continue;
      const dst = path.join(dsh, "lib/node_modules", rel);
      if (!fs.existsSync(dst)) fs.cpSync(path.join(out, "npm-extra/node_modules", rel), dst, { recursive: true });
    }
    log("compat npm", name, version);
  }
  fs.rmSync(path.join(out, "npm-extra"), { recursive: true, force: true });

  // 4. ash core.
  const core = path.join(ROOT, "packages/core/dist/ash-core.mjs");
  if (!fs.existsSync(core)) throw new Error("build ash core first: npm run build:core");
  fs.mkdirSync(path.join(tree, "ash"), { recursive: true });
  fs.copyFileSync(core, path.join(tree, "ash/ash-core.mjs"));

  // 5. wrappers.
  const wrappers = path.join(HERE, "wrappers");
  fs.mkdirSync(path.join(tree, "bin"), { recursive: true });
  for (const w of fs.readdirSync(wrappers)) {
    fs.copyFileSync(path.join(wrappers, w), path.join(tree, "bin", w));
    exec.push(`bin/${w}`);
    if (fs.readFileSync(path.join(wrappers, w), "utf8").includes(PLACEHOLDER)) placeholders.push(`bin/${w}`);
  }

  // Host-owned DSH patch layer (passed to runProfile as a patch file, never written into DSH).
  fs.cpSync(path.join(HERE, "profile"), path.join(tree, "profile"), { recursive: true });
  for (const f of fs.readdirSync(path.join(tree, "profile"))) placeholders.push(`profile/${f}`);

  // 6. symlinks and zip; the index tells the host what to recreate.
  for (const [from] of links) fs.rmSync(path.join(tree, from), { force: true });
  for (const [rel, e] of walk(tree)) if (e.isSymbolicLink()) {
    if (!links.some(([from]) => from === rel)) links.push([rel, fs.readlinkSync(path.join(tree, rel))]);
    fs.rmSync(path.join(tree, rel));
  }
  const inputs = createHash("sha256").update(JSON.stringify(manifest)).update(fs.readFileSync(core)).digest("hex").slice(0, 16);
  const entries = [...walk(tree)].length + 1;
  const index = { schema: 1, build: `${manifest.dsh.version}-${inputs}`, entries, dsh: manifest.dsh, links, exec: [...new Set(exec)].sort(), placeholders: [...new Set(placeholders)].sort(), placeholder: PLACEHOLDER, dshTree };
  fs.writeFileSync(path.join(tree, "payload-index.json"), JSON.stringify(index));
  fs.rmSync(path.join(out, "payload.zip"), { force: true });
  sh("zip", ["-q", "-r", "-X", "-9", path.join(out, "payload.zip"), "."], { cwd: tree });
  fs.copyFileSync(path.join(tree, "payload-index.json"), path.join(out, "payload-index.json"));
  const size = (fs.statSync(path.join(out, "payload.zip")).size / 1e6).toFixed(1);
  log(`done: ${out}/payload.zip (${size} MB), build ${index.build}, ${links.length} links, ${index.exec.length} executables`);
}

/** sha256 of every file under a directory, for the "DSH exactly as published" check (R12). */
function hashTree(dir) {
  const h = createHash("sha256");
  let files = 0;
  for (const [rel, e] of [...walk(dir)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (e.isSymbolicLink()) h.update(`L ${rel} ${fs.readlinkSync(path.join(dir, rel))}\n`);
    else if (e.isFile()) {
      h.update(`F ${rel} ${sha256(path.join(dir, rel))}\n`);
      files++;
    }
  }
  return { files, sha256: h.digest("hex") };
}

if (flag("--lock")) await lock();
else await build();

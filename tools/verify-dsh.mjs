#!/usr/bin/env node
// R12 — "DSH exactly as published": hash every file of @deepseek-ai/** inside an installed DSH.
//   node tools/verify-dsh.mjs <…/node_modules/@deepseek-ai/dsh>
// payload/assemble.mjs installs a desktop DSH of the same version at the same moment and refuses
// to build unless both fingerprints match (DSH pins its own packages exactly, but some transitive
// ranges float — only a same-moment install is a fair reference); the fingerprint is recorded in
// payload-index.json (dshVerify), and on the phone this must still reproduce it (nothing changed).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export function dshFingerprint(root) {
const files = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) files.push([relative(root, p), `L:${readlinkSync(p)}`]);
    else if (e.isDirectory()) walk(p);
    else if (e.isFile()) files.push([relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex")]);
  }
}
// The CLI package itself (minus its node_modules) …
for (const e of readdirSync(root, { withFileTypes: true })) {
  if (e.name === "node_modules") continue;
  const p = join(root, e.name);
  if (e.isDirectory()) walk(p);
  else if (e.isFile()) files.push([e.name, createHash("sha256").update(readFileSync(p)).digest("hex")]);
}
// … and every @deepseek-ai package it depends on, except platform packages (package.json with
// "os"/"cpu"): those are chosen per platform by npm, by design.
const scope = join(root, "node_modules", "@deepseek-ai");
const skipped = [];
for (const name of readdirSync(scope)) {
  const pj = JSON.parse(readFileSync(join(scope, name, "package.json"), "utf8"));
  if (pj.os || pj.cpu) skipped.push(name);
  else walk(join(scope, name));
}
files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const h = createHash("sha256");
for (const [f, d] of files) h.update(`${f} ${d}\n`);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
return { line: `dsh ${version} @deepseek-ai files=${files.length} sha256=${h.digest("hex")}`, skipped };
}

if (process.argv[1] && process.argv[1].endsWith("verify-dsh.mjs")) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: verify-dsh.mjs <dsh package dir>");
    process.exit(1);
  }
  const r = dshFingerprint(root);
  console.log(r.line);
  if (process.argv.includes("-v")) console.log(`platform packages not compared: ${r.skipped.join(", ") || "none"}`);
}

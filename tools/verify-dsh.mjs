#!/usr/bin/env node
// R12 — "DSH exactly as published": hash every file of @deepseek-ai/** inside an installed DSH.
//   node tools/verify-dsh.mjs <…/node_modules/@deepseek-ai/dsh>
// Run it on the phone's payload and on a desktop `npm install -g @deepseek-ai/dsh@<same version>`;
// the two lines must be identical (platform packages outside @deepseek-ai/ may differ by design).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: verify-dsh.mjs <dsh package dir>");
  process.exit(1);
}
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
console.log(`dsh ${version} @deepseek-ai files=${files.length} sha256=${h.digest("hex")}`);
if (process.argv.includes("-v")) console.log(`platform packages not compared: ${skipped.join(", ") || "none"}`);

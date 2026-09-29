#!/usr/bin/env node
// Finish an extracted payload the way the Android host does (PayloadInstaller.kt): recreate symlinks,
// set exec bits, fill the @PAYLOAD@ placeholder with the real install path. For dev/test use:
//   unzip -q payload.zip -d <dir> && node tools/apply-payload-index.mjs <dir>
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const index = JSON.parse(fs.readFileSync(path.join(dir, "payload-index.json"), "utf8"));
for (const [from, target] of index.links) {
  const p = path.join(dir, from);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.rmSync(p, { force: true });
  fs.symlinkSync(target, p);
}
for (const f of index.placeholders) {
  const p = path.join(dir, f);
  fs.writeFileSync(p, fs.readFileSync(p, "latin1").replaceAll(index.placeholder, dir), "latin1");
}
for (const f of index.exec) fs.chmodSync(path.join(dir, f), 0o755);
console.log(`payload ${index.build}: ${index.links.length} links, ${index.exec.length} executables, ${index.placeholders.length} placeholders → ${dir}`);

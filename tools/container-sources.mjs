#!/usr/bin/env node
// The ash packages the agent container carries (tools/build-container-rootfs.mjs copies them into /opt/ash).
// Their digest is recorded next to the built container; building the APK refuses a container whose copy is stale,
// so a change to a skill or the control plugin can never ship inside an older container.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTAINER_PACKAGES = ["dsh-ash-control", "ash-skills"];

/** One digest over every file of the carried packages (relative path and bytes, in a fixed order). */
export function containerSourcesDigest(root) {
  const h = createHash("sha256");
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
      const abs = path.join(dir, name), r = `${rel}/${name}`;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) { h.update(r + "\0"); h.update(fs.readFileSync(abs)); h.update("\0"); }
    }
  };
  for (const pkg of CONTAINER_PACKAGES) walk(path.join(root, "packages", pkg), pkg);
  return h.digest("hex");
}

// `node tools/container-sources.mjs --check build/container`: fail when the built container's copy is stale.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.resolve(root, process.argv[process.argv.indexOf("--check") + 1] ?? "build/container");
  const file = path.join(dir, "SOURCES");
  const want = containerSourcesDigest(root);
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
  if (have !== want) {
    console.error(`container: ${have ? "its copy of" : "no record of"} ${CONTAINER_PACKAGES.join(", ")} ${have ? "is older than the source" : "in " + dir}; run \`npm run build:container\``);
    process.exit(1);
  }
  console.log("container: carried packages match the source");
}

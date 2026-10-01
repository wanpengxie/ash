// A test-only byte-for-byte static artifact; no Android production entry loads it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = join(root, "packages/core/src/ui.ts");
const testDirectory = join(root, "build/spikes/ASH-604-origin/static-ui");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function coreUiBytes(source = readFileSync(sourcePath, "utf8")) {
  const match = /^export const UI_HTML: string = (".*");$/m.exec(source);
  if (!match) throw new Error("generated core UI missing");
  const html = JSON.parse(match[1]);
  if (typeof html !== "string" || !html.toLowerCase().startsWith("<!doctype html>")) throw new Error("invalid core UI");
  return Buffer.from(html, "utf8");
}

export function staticManifest(bytes = coreUiBytes()) {
  return { source: "packages/core/src/ui.ts:UI_HTML", bytes: bytes.length, sha256: digest(bytes) };
}

export function verifyStaticUi(bytes, manifest, expected = coreUiBytes()) {
  if (!Buffer.isBuffer(bytes) || !manifest || bytes.length !== manifest.bytes ||
      digest(bytes) !== manifest.sha256 || !bytes.equals(expected)) throw new Error("static UI differs from generated core UI");
  return true;
}

export function writeTestStaticUi(directory = testDirectory) {
  const bytes = coreUiBytes();
  const manifest = staticManifest(bytes);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), bytes);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
  verifyStaticUi(readFileSync(join(directory, "index.html")), JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = writeTestStaticUi();
  console.log(JSON.stringify({ bytes: manifest.bytes, sha256: manifest.sha256, parity: true }));
}

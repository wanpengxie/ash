import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) visit(path);
      else if (e.isFile()) out.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  visit(root);
  return out;
}

/** Scenario harness: authorize paths when the self member handles a write request. */
export class IntrinsicMonitor {
  private before: Map<string, string>;
  private allowed = new Set<string>();
  constructor(private readonly root: string) { this.before = snapshot(root); }
  authorize(path: string) { this.allowed.add(path); }
  violations(): string[] {
    const after = snapshot(this.root);
    const changes = new Set([...this.before.keys(), ...after.keys()]);
    return [...changes].filter(path => this.before.get(path) !== after.get(path) && !this.allowed.has(path)).sort();
  }
}

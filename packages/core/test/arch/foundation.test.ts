import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTree, type Finding } from "./checks";
import { IntrinsicMonitor } from "./intrinsic-monitor";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clean = () => ({
  "packages/core/src/members/main.ts": 'import { send } from "../world/router"; export const main = send;',
  "packages/core/src/members/self.ts": 'export const self = true;',
  "packages/core/src/world/router.ts": 'export const send = true;',
  "packages/core/src/server.ts": 'switch (route) { case "POST /api/send": break; case "GET /api/stream": break; case "GET /api/describe": break; }',
  "packages/core/src/workers/extract.ts": 'export const extract = true;',
  "packages/core/src/flows/memory.ts": 'export const memory = true;',
  "packages/core/ui/js/app.js": 'fetch("/api/describe"); new EventSource("/api/stream?after=0");',
});

test("architecture fixture: clean tree has no findings", () => assert.deepEqual(checkTree(clean()), []));

for (const [rule, file, bad] of [
  ["AR1", "packages/core/src/members/main.ts", 'import "./other";'],
  ["AR2", "packages/core/ui/js/app.js", 'fetch("/api/settings");'],
  ["AR3", "packages/core/src/server.ts", 'switch (route) { case "POST /api/send": break; case "GET /api/stream": break; case "GET /api/describe": break; case "POST /api/call": break; }'],
  ["AR4", "packages/core/src/workers/extract.ts", 'import { writeFileSync } from "node:fs";'],
  ["AR12", "packages/core/src/world/router.ts", String.fromCharCode(65, 116, 111, 108, 108)],
] as const) {
  test(`${rule}: deliberate violation is reported`, () => {
    const tree = clean();
    tree[file] = bad;
    const findings = checkTree(tree).filter((f: Finding) => f.rule === rule);
    assert.ok(findings.length, `${rule} missed deliberate violation`);
    assert.equal(findings[0].file, file);
  });
}

test("AR checks fail closed when target sources are missing", () => {
  const findings = checkTree({});
  for (const rule of ["AR1", "AR2", "AR3", "AR4"]) assert.ok(findings.some(f => f.rule === rule), `${rule} silently passed`);
});

test("AR12 token boundaries distinguish encoded substrings from written terms", () => {
  const tree = clean();
  const term = String.fromCharCode(68, 50, 49);
  tree["packages/core/src/world/router.ts"] = `const digest = "f00${term}beef";`;
  assert.equal(checkTree(tree, [term]).filter(f => f.rule === "AR12").length, 0);
  tree["packages/core/src/world/router.ts"] = `// ${term} is an architecture identifier`;
  assert.equal(checkTree(tree, [term]).filter(f => f.rule === "AR12").length, 1);
});

test("AR4 runtime monitor identifies a write without self authorization", () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-intrinsic-test-"));
  const monitor = new IntrinsicMonitor(dir);
  writeFileSync(join(dir, "MEMORY.md"), "changed");
  assert.deepEqual(monitor.violations(), ["MEMORY.md"]);
  monitor.authorize("MEMORY.md");
  assert.deepEqual(monitor.violations(), []);
});

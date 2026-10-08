import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain ESM plugin shipped beside the package
import { apply as applyUntyped, discoverSkills as discoverUntyped, metadata as metadataUntyped } from "../index.mjs";

interface Found { folder: string; directory: string; locator: string; name: string; description: string; whenToUse: string; content: string }
const discoverSkills = discoverUntyped as (base?: string) => Found[];
const metadata = metadataUntyped as (raw: string, file: string) => Found;
const apply = applyUntyped as (ctx: { skills: { registerProvider(make: () => unknown): void } }) => void;

const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: 一句话说明\nwhenToUse: 什么时候用\n---\n\n# ${name}\n${extra}\n`;

function scratch(files: Record<string, string>, run: (base: string) => void | Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "ash-skills-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(base, path, ".."), { recursive: true });
      writeFileSync(join(base, path), text);
    }
    return run(base);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test("every bundled skill folder is discovered, in a stable order, including senses", () => {
  const base = new URL("../skills/", import.meta.url).pathname;
  const folders = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const found = discoverSkills();
  assert.deepEqual(found.map((item) => item.folder), folders);
  assert.ok(found.some((item) => item.name === "ash-senses"), "the senses skill must not be left out");
  assert.deepEqual(discoverSkills().map((item) => item.name), found.map((item) => item.name));
  assert.equal(new Set(found.map((item) => item.name)).size, found.length);
});

test("discovery takes any folder with a SKILL.md and ignores folders without one", () => scratch({
  "zeta/SKILL.md": skill("zeta"), "alpha/SKILL.md": skill("alpha"), "alpha/extra/sample.json": "{}", "notes/readme.txt": "not a skill",
}, (base) => {
  assert.deepEqual(discoverSkills(base).map((item) => item.name), ["alpha", "zeta"]);
}));

test("a broken skill stops discovery loudly", async () => {
  await scratch({ "a/SKILL.md": "# no frontmatter\n" }, (base) => assert.throws(() => discoverSkills(base), /missing frontmatter/));
  await scratch({ "a/SKILL.md": "---\nname: a\ndescription: x\n---\nbody" }, (base) => assert.throws(() => discoverSkills(base), /whenToUse/));
  await scratch({ "a/SKILL.md": "---\nname: a\ndescription:\nwhenToUse: x\n---\nbody" }, (base) => assert.throws(() => discoverSkills(base), /description/));
  await scratch({ "a/SKILL.md": skill("Bad Name") }, (base) => assert.throws(() => discoverSkills(base), /bad skill name/));
  await scratch({ "a/SKILL.md": skill("same"), "b/SKILL.md": skill("same") }, (base) => assert.throws(() => discoverSkills(base), /used by both/));
});

test("metadata returns the body without the frontmatter", () => {
  const parsed = metadata(skill("demo", "正文"), "demo/SKILL.md");
  assert.equal(parsed.name, "demo");
  assert.match(parsed.content, /^# demo/u);
  assert.doesNotMatch(parsed.content, /whenToUse/u);
});

test("the plugin registers every discovered skill and serves its body", async () => {
  let provider: any;
  apply({ skills: { registerProvider: (make: () => unknown) => { provider = make(); } } });
  const listed = await provider.list();
  assert.deepEqual(listed.map((item: { name: string }) => item.name), discoverSkills().map((item) => item.name));
  const senses = listed.find((item: { name: string }) => item.name === "ash-senses");
  const loaded = await provider.get(senses);
  assert.ok(loaded.content.length > 100);
  assert.doesNotMatch(loaded.content, /^---/u);
  assert.equal(loaded.resourceBase.kind, "directory");
});

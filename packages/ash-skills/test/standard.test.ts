import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { MAIN_RULES } from "../../core/src/workers/rules.generated";
// @ts-expect-error plain ESM plugin shipped beside the package
import { discoverSkills as discoverUntyped } from "../index.mjs";

/**
 * The two-layer standard for guiding the main agent, enforced:
 *  - layer 1, an introduction per capability domain in the system prompt (prompts/rules/): a few sentences saying what it is, what it
 *    can do and when to use it, and naming the skill to read first. No steps, no examples, no parameter lists.
 *  - layer 2, the detailed skill (skills/<name>/SKILL.md): when to use, how, what good looks like, common mistakes, how to check.
 * Details live only in skills. Add a capability domain and you add both, or this test fails.
 */
interface Skill { folder: string; directory: string; locator: string; name: string; description: string; whenToUse: string; content: string }
const discoverSkills = discoverUntyped as (base?: string) => Skill[];

const rulesDir = join(import.meta.dirname, "../../core/src/prompts/rules");
const generator = join(import.meta.dirname, "../../../tools/gen-worker-rules.mjs");
const skills = discoverSkills();
const names = new Set(skills.map((skill) => skill.name));
const ruleFiles = readdirSync(rulesDir).filter((file) => file.endsWith(".md")).map((file) => basename(file, ".md")).sort();
const rule = (name: string) => readFileSync(join(rulesDir, `${name}.md`), "utf8").trim();

/** Rules that are not "how to use a capability": how the world works, who may do what, how to speak. They may stay long. */
const SYSTEM_RULES = new Set(["approvals", "gate", "data-not-instructions", "self-files", "voice", "reactions", "env", "tools", "agents"]);
/** Skills started by a wake-up or an event rather than by a capability the owner or the agent reaches for. */
const NOT_NAMED_BY_AN_INTRO = new Set(["first-meeting"]);
/** Skills that predate the section layout below; they keep their own. */
const OLDER_LAYOUT = new Set(["first-meeting", "forget", "ash-self-evidence", "ash-broad-inquiry"]);
/** Skills whose name differs from the folder (the name is what the agent sees). */
const NAME_NOT_FOLDER = new Map([["self-awareness", "ash-self-evidence"], ["senses", "ash-senses"], ["wide-research", "ash-broad-inquiry"]]);
/** The system prompt must not grow past what it was before the two layers: details moved out, introductions came in. */
const MAX_MAIN_RULES_CHARS = 8333;
const INTRO_MAX_SENTENCES = 5;
const INTRO_MAX_CHARS = 400;
const SKILL_MAX_BYTES = 9000;
/** Detail that belongs in a skill; seeing it in the system prompt means the layers have blurred again. */
const DETAIL_ONLY_IN_SKILLS = ["widget.card.put", "widget.card.validate", "apps.scaffold", "apps.validate", "apps.contract", "apps.restart", "apps.logs",
  "apps.reset", "apps.remove", "browser.run", "vscreen.create", "workspace.write"];

const withoutCode = (text: string) => text.replace(/`[^`]*`/gu, "x");
const body = (text: string) => text.split("\n").filter((line) => !line.startsWith("#")).join("\n").trim();
const sentences = (text: string) => (withoutCode(body(text)).match(/[。！？!?]+|\.(?=\s|$)/gu) ?? []).length;
const skillRefs = (text: string) => [...text.matchAll(/技能\s*`([^`]+)`/gu)].map((match) => match[1]!);

test("every skill folder has a SKILL.md with valid frontmatter, and the names are unique", () => {
  const folders = readdirSync(join(import.meta.dirname, "../skills")).filter((entry) => statSync(join(import.meta.dirname, "../skills", entry)).isDirectory());
  assert.deepEqual(skills.map((skill) => skill.folder).sort(), folders.sort(), "a skill folder without a SKILL.md is never loaded");
  assert.equal(names.size, skills.length);
  for (const skill of skills) {
    assert.ok(skill.description.length >= 10 && !skill.description.includes("\n"), `${skill.name}: description is one line`);
    assert.ok(skill.whenToUse.length >= 10 && !skill.whenToUse.includes("\n"), `${skill.name}: whenToUse is one line`);
    assert.ok(skill.content.length > 300, `${skill.name}: the body says something`);
    assert.equal(skill.name, NAME_NOT_FOLDER.get(skill.folder) ?? skill.folder, `${skill.folder}: the skill name is the folder name`);
  }
});

test("each skill is focused, and follows the layout: when to use, how, what good looks like, mistakes, how to check", () => {
  for (const skill of skills) {
    const bytes = Buffer.byteLength(readFileSync(skill.locator, "utf8"));
    assert.ok(bytes <= SKILL_MAX_BYTES, `${skill.name} is ${bytes} bytes; move reference material into a file beside it`);
    if (OLDER_LAYOUT.has(skill.name)) continue;
    const headings = skill.content.split("\n").filter((line) => /^#{1,3} /u.test(line)).join("\n");
    assert.match(headings, /好的样子/u, `${skill.name}: needs a "好的样子" section with a worked example`);
    assert.match(headings, /常见错误/u, `${skill.name}: needs a "常见错误" section`);
    assert.match(headings, /怎么核对/u, `${skill.name}: needs a "怎么核对" section`);
    assert.ok(/做法|怎么|先|步骤/u.test(headings), `${skill.name}: needs a how-to section`);
  }
});

test("sample files in a skill folder are referenced from its SKILL.md, and what it points at exists", () => {
  for (const skill of skills) {
    const text = readFileSync(skill.locator, "utf8");
    const extras = readdirSync(skill.directory).filter((entry) => entry !== "SKILL.md");
    for (const entry of extras) assert.ok(text.includes(entry), `${skill.name}: ${entry} is not mentioned in SKILL.md`);
    const tops = new Set(extras);
    for (const token of [...text.matchAll(/`([^`\s]+)`/gu)].map((match) => match[1]!)) {
      const [top] = token.split("/");
      if (token.includes("/") && tops.has(top!) && !token.includes("<") && !token.includes("*")) assert.ok(existsSync(join(skill.directory, token)), `${skill.name}: \`${token}\` does not exist`);
    }
  }
});

test("every rules file is either a system rule or a capability introduction, and the prompt builder includes it", () => {
  const listed = /const mainRuleNames = \[([^\]]*)\]/u.exec(readFileSync(generator, "utf8"))?.[1]?.match(/"([^"]+)"/gu)?.map((item) => item.slice(1, -1));
  assert.ok(listed, "tools/gen-worker-rules.mjs lists the main rules");
  assert.deepEqual([...listed!].sort(), ruleFiles, "every file in prompts/rules/ is in mainRuleNames (and none is missing on disk)");
  assert.equal(MAIN_RULES, listed!.map(rule).join("\n\n"), "rules.generated.ts is current: run npm run gen:worker-rules");
  for (const name of SYSTEM_RULES) assert.ok(ruleFiles.includes(name), `${name}.md is a system rule that no longer exists`);
});

test("each capability introduction is short, names its skill, and carries no steps or examples", () => {
  const intros = ruleFiles.filter((name) => !SYSTEM_RULES.has(name));
  assert.ok(intros.length >= 8, `found ${intros.join(", ")}`);
  for (const name of intros) {
    const text = rule(name);
    const lines = body(text).split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `${name}: one short paragraph, not a list`);
    assert.ok(sentences(text) >= 2 && sentences(text) <= INTRO_MAX_SENTENCES, `${name}: ${sentences(text)} sentences, want 2 to ${INTRO_MAX_SENTENCES}`);
    assert.ok([...body(text)].length <= INTRO_MAX_CHARS, `${name}: ${[...body(text)].length} characters, at most ${INTRO_MAX_CHARS}`);
    assert.doesNotMatch(text, /```|\n\s*(?:[-*]|\d+[.)]) |[{}]/u, `${name}: no steps, examples or parameter lists in an introduction`);
    const named = skillRefs(text);
    assert.ok(named.length >= 1, `${name}: names the skill to read, as 先读技能 \`<name>\``);
    for (const skill of named) assert.ok(names.has(skill), `${name}: skill \`${skill}\` does not exist`);
  }
});

test("every skill a rule names exists, and no skill is left unnamed", () => {
  const named = new Set<string>();
  for (const name of ruleFiles) for (const skill of skillRefs(rule(name))) {
    assert.ok(names.has(skill), `${name}.md names skill \`${skill}\`, which does not exist`);
    named.add(skill);
  }
  for (const skill of skills) {
    if (NOT_NAMED_BY_AN_INTRO.has(skill.name)) continue;
    assert.ok(named.has(skill.name), `skill ${skill.name} is not named by any rule: add it to an introduction`);
  }
});

test("details stay out of the system prompt, and the prompt does not grow", () => {
  for (const token of DETAIL_ONLY_IN_SKILLS) assert.ok(!MAIN_RULES.includes(token), `${token} is detail: it belongs in a skill`);
  assert.ok([...MAIN_RULES].length <= MAX_MAIN_RULES_CHARS, `the rules are ${[...MAIN_RULES].length} characters, over ${MAX_MAIN_RULES_CHARS}`);
});

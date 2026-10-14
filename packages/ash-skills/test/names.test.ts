import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../../core/src/edges/tools";
import { BROWSER_EXTENSIONS } from "../../sdk/src/namespaces";

/**
 * What the agent reads (prompts/rules/*.md and the skills' markdown) uses only names the contract has:
 *  - nothing from before the new contract (`device:phone`, `human_notify`, the old tool names, the old words);
 *  - every word, `member/word` pair and tool name written in code spans, or in a `capability_call {member, word}`, is in
 *    packages/sdk/schema/words.json, TOOL_NAMES, or the browser extensions the contract lists.
 * A name that is not checked is one the contract cannot vouch for: app tools (`app:<id>`), tool arguments, event reasons.
 * What this does not catch, and a reviewer has to read: a call written with quoted keys (`{"member": …, "word": …}`), and whether a
 * word belongs to the member it is paired with in prose, or takes the arguments the text gives it (only `member/word` pairs and
 * `capability_call {member: "…", word: "…"}` are matched).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const words = (JSON.parse(readFileSync(join(root, "packages/sdk/schema/words.json"), "utf8")) as { words: { member: string; word: string }[] }).words;

const markdown = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? markdown(path) : path.endsWith(".md") ? [path] : [];
});
const files = [...markdown(join(root, "packages/core/src/prompts/rules")), ...markdown(join(root, "packages/ash-skills/skills"))].sort();
const read = (file: string) => readFileSync(file, "utf8");
const where = (file: string) => relative(root, file);

/** Gone with the old contract. `browser.run` and `browser.show` are only legal as `x.android.browser.*`. */
const OLD: [string, RegExp][] = [
  ["device:phone", /device:phone/u],
  ["human_notify", /human_notify/u],
  ["device_diagnose", /device_diagnose/u],
  ["gateway_status", /gateway_status/u],
  ["gateway_setup_guide", /gateway_setup_guide/u],
  ["intent.view", /intent\.view/u],
  ["bare browser.run / browser.show", /(?<![.\w])browser\.(?:run|show)\b/u],
  ["the gate raising the card and waiting", /弹出审批卡并等|自己弹出审批卡/u],
  ["timer_set deliver:", /deliver:\s*"?(?:owner|self)/u],
];

test("no rule or skill still uses a name from before the new contract", () => {
  assert.ok(files.length > 30, `found ${files.length} files`);
  for (const file of files) for (const [name, pattern] of OLD) assert.doesNotMatch(read(file), pattern, `${where(file)} still says ${name}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// every name that is written down exists
// ---------------------------------------------------------------------------------------------------------------------

const wordsOf = (member: string): Set<string> => new Set(words.filter((w) => w.member === member).map((w) => w.word));
const members = new Set(words.map((w) => w.member));
const allWords = new Set(words.map((w) => w.word));
const namespaces = new Set([...allWords].filter((w) => w.includes(".")).map((w) => w.split(".")[0]!));
const extensions = new Set(BROWSER_EXTENSIONS);

/** `device:<编号>` and `body:<编号>` stand for every hand and body; `agent:<名字>` for every agent. */
function memberKey(id: string): string | null {
  if (id.startsWith("app:")) return null;                       // an app's own tools are the app's
  if (/^(device|body|agent):/u.test(id)) return `${id.split(":")[0]}:*`;
  return id;
}

/** The first token of a code span, without a trailing argument list or punctuation. */
const head = (span: string) => span.trim().split(/[\s{(]/u)[0]!.replace(/[,;:，；：。]+$/u, "");

/** The tool-name prefixes: a snake_case name starting with one of these has to be a tool. `human_kind` and `approval_ttl_minutes` are fields of tool arguments. */
const TOOL_PREFIXES = new Set(["human", "device", "agent", "timer", "approval", "vault", "history", "system", "capability"]);
const NOT_TOOLS = new Set(["human_kind", "approval_ttl_minutes"]);
/** A file name is not a word, whatever its first part looks like (`rules.mjs`). */
const FILE = /\.(?:mjs|js|json|md|html|css|ts)$/u;

interface Problem { file: string; name: string; why: string }

function check(file: string): Problem[] {
  const text = read(file);
  const problems: Problem[] = [];
  const bad = (name: string, why: string) => problems.push({ file: where(file), name, why });

  const word = (name: string) => {
    if (name.startsWith("x.")) { if (!name.endsWith(".*") && !extensions.has(name)) bad(name, "not an extension in BROWSER_EXTENSIONS"); return; }
    if (name.endsWith(".*")) { if (!namespaces.has(name.slice(0, -2)) && !name.startsWith("x.android.browser")) bad(name, "no such namespace"); return; }
    if (!allWords.has(name)) bad(name, "not in words.json");
  };

  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const span = match[1]!;
    const token = head(span);
    // member/word, e.g. service:link/diagnose or body:<编号>/body.info
    const pair = /^((?:service|agent|person|app|device|body):[^/\s{]+)\/([^\s{(]+)$/u.exec(token);
    if (pair) {
      const key = memberKey(pair[1]!);
      if (key === null) continue;
      if (!members.has(key)) bad(token, `no member ${key}`);
      else if (!wordsOf(key).has(pair[2]!)) bad(token, `${key} has no word ${pair[2]}`);
      continue;
    }
    // a member alone
    if (/^(?:service|person):[a-z]+$/u.test(token)) { if (!members.has(token)) bad(token, "no such member"); continue; }
    // a tool name
    const tool = /^([a-z]+)(?:_[a-z0-9]+)+$/u.exec(token);
    if (tool && TOOL_PREFIXES.has(tool[1]!) && !NOT_TOOLS.has(token)) { if (!TOOL_NAMES.includes(token)) bad(token, "not in TOOL_NAMES"); continue; }
    // a word: ns.word, ns.*, x.android.browser.run
    if (!FILE.test(token) && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.(?:[a-z0-9_]+|\*)$/u.test(token) && (token.startsWith("x.") || namespaces.has(token.split(".")[0]!))) word(token);
  }

  // capability_call {member: "…", word: "…"}
  for (const match of text.matchAll(/member:\s*"([^"]+)"[^}\n]*?word:\s*"([^"]+)"/gu)) {
    const key = memberKey(match[1]!);
    if (key === null || /[<>]/u.test(match[1]!) && !/^(device|body|agent):</u.test(match[1]!)) continue;
    if (!members.has(key)) bad(`${match[1]}/${match[2]}`, `no member ${key}`);
    else if (!wordsOf(key).has(match[2]!)) bad(`${match[1]}/${match[2]}`, `${key} has no word ${match[2]}`);
  }
  return problems;
}

/** Names the rules and skills use that the contract does not have, with who owns the fix. Empty when there are none. */
const NOT_MINE: Record<string, string> = {
  // first-meeting is not changed by the task that wrote this test; the contract has no service:self. A later task fixes the skill.
  "packages/ash-skills/skills/first-meeting/SKILL.md service:self/read": "a later task",
  "packages/ash-skills/skills/first-meeting/SKILL.md service:self/write": "a later task",
};

test("every word and tool a rule or skill names is in words.json, TOOL_NAMES or the browser extensions", () => {
  const problems = files.flatMap(check).filter((p) => NOT_MINE[`${p.file} ${p.name}`] === undefined);
  assert.deepEqual(problems.map((p) => `${p.file}: ${p.name} (${p.why})`), []);
});

test("the checker catches what it is for", () => {
  assert.ok(TOOL_NAMES.includes("human_say") && !TOOL_NAMES.includes("human_notify"));
  assert.ok(allWords.has("apps.open_url") && !allWords.has("intent.view"));
  assert.ok(extensions.has("x.android.browser.run") && extensions.has("x.android.browser.show"));
  assert.ok(wordsOf("service:link").has("diagnose") && wordsOf("service:link").has("gateway.use"));
  assert.ok(wordsOf("body:*").has("body.info") && wordsOf("device:*").has("config.status"));
});

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./skills/", import.meta.url));
const FIELDS = ["name", "description", "whenToUse"];

/** Frontmatter is three single-line fields; anything else is a mistake worth stopping for. */
export function metadata(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error(`ash-skills: missing frontmatter in ${file}`);
  const field = (key) => new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(match[1])?.[1]?.trim();
  const out = Object.fromEntries(FIELDS.map((key) => [key, field(key)]));
  const missing = FIELDS.filter((key) => !out[key]);
  if (missing.length) throw new Error(`ash-skills: incomplete frontmatter in ${file}: ${missing.join(", ")} missing or empty (each is one line)`);
  if (!/^[a-z][a-z0-9-]*$/u.test(out.name)) throw new Error(`ash-skills: bad skill name "${out.name}" in ${file} (lowercase letters, digits and - only)`);
  return { ...out, content: raw.slice(match[0].length).trim() };
}

/**
 * Every directory under skills/ that holds a SKILL.md, in name order. A bad SKILL.md or a repeated skill name throws,
 * so a broken skill stops the plugin instead of silently going missing.
 */
export function discoverSkills(base = root) {
  const folders = readdirSync(base).filter((entry) => statSync(join(base, entry)).isDirectory()).sort();
  const skills = [];
  const seen = new Map();
  for (const folder of folders) {
    const directory = join(base, folder);
    const locator = join(directory, "SKILL.md");
    if (!existsSync(locator)) continue;
    const skill = metadata(readFileSync(locator, "utf8"), locator);
    if (seen.has(skill.name)) throw new Error(`ash-skills: skill name "${skill.name}" is used by both ${seen.get(skill.name)} and ${folder}`);
    seen.set(skill.name, folder);
    skills.push({ folder, directory, locator, ...skill });
  }
  return skills;
}

export const name = "ash-skills";
export const inject = ["skills"];

export function apply(ctx) {
  const candidates = discoverSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: "ash-skills",
    source: "bundled",
    rank: 600,
    resourceBase: { kind: "directory", path: skill.directory },
    locator: skill.locator,
  }));
  ctx.skills.registerProvider(() => ({
    name: "ash-skills",
    list: async () => candidates,
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await readFile(locator, { encoding: "utf8", signal: options?.signal });
      return { ...summary, content: metadata(raw, locator).content };
    },
  }));
}

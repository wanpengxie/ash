import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const names = ["first-meeting", "self-awareness", "forget", "wide-research", "pulse-widget"];
const root = fileURLToPath(new URL("./skills/", import.meta.url));

function metadata(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error(`ash-skills: missing frontmatter in ${file}`);
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(match[1])?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  const whenToUse = field("whenToUse");
  if (!name || !description || !whenToUse) throw new Error(`ash-skills: incomplete frontmatter in ${file}`);
  return { name, description, whenToUse, content: raw.slice(match[0].length).trim() };
}

export const name = "ash-skills";
export const inject = ["skills"];

export function apply(ctx) {
  const candidates = names.map((folder) => {
    const directory = join(root, folder);
    const locator = join(directory, "SKILL.md");
    const skill = metadata(readFileSync(locator, "utf8"), locator);
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: "ash-skills",
      source: "bundled",
      rank: 600,
      resourceBase: { kind: "directory", path: directory },
      locator,
    };
  });
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

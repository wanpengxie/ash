import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { levels, validateCard, type WidgetComponent } from "../../src/members/widgets-card";

// The sample cards the widgets-design skill hands to the agent must be cards the phone would accept as they are.
const dir = join(import.meta.dirname, "../../../ash-skills/skills/widgets-design/cards");
const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

interface Sample { id: string; title: string; size: string; ttl_min?: number; a2ui: Record<string, unknown> }
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Sample;

test("the skill ships a small library of sample cards", () => {
  assert.ok(files.length >= 4 && files.length <= 8, `found ${files.join(", ")}`);
});

for (const file of files) {
  test(`sample card ${file} is a valid widget.card.put body`, () => {
    const sample = read(file);
    assert.match(sample.id, /^[a-z0-9][a-z0-9._-]{0,63}$/u);
    assert.ok(sample.title.length >= 1 && sample.title.length <= 40, "title is 1 to 40 characters");
    assert.ok(["2x2", "4x2", "4x4"].includes(sample.size));
    if (sample.ttl_min !== undefined) assert.ok(Number.isInteger(sample.ttl_min) && sample.ttl_min >= 1 && sample.ttl_min <= 43200);
    const render = validateCard(sample.a2ui);
    const byId = new Map(render.components.map((c) => [c.id, c] as [string, WidgetComponent]));
    const roots = [render.root, ...(render.sizes ?? []).map((size) => size.root)];
    for (const root of roots) assert.ok(levels(byId, root) <= (render.sizes ? 9 : 10));
  });

  test(`sample card ${file} follows the design rules the skill teaches`, () => {
    const text = readFileSync(join(dir, file), "utf8");
    // A bare hex colour is wrong in one of the two modes; samples use theme names or a {light, dark} pair.
    const bare = [...text.matchAll(/"(?:color|background)":\s*"(#[0-9A-Fa-f]{3,8})"/gu)];
    assert.deepEqual(bare.map((match) => match[1]), [], "use a theme colour or {light, dark}");
    const sample = read(file);
    const components = sample.a2ui.components as { id: string; component: string; style?: Record<string, unknown> }[];
    const root = components.find((c) => c.id === "root")!;
    if (root.style?.background !== undefined) assert.ok(root.style.color !== undefined, "a root background needs a text colour to go with it");
  });
}

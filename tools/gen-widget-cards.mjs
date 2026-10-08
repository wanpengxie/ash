#!/usr/bin/env node
// The card cases both sides test against: each case's a2ui, what the core says about it, and (when it gets that far)
// the resolved components the phone draws. The phone's WidgetPlanTest reads the same file, so the core's checks and
// the phone's drawing cannot drift apart. Edit packages/core/test/fixtures/widget-cards.cases.mjs, then `npm run gen:widget-cards`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "../packages/core/test/fixtures/widget-cards.cases.mjs";
import { CARD_AVATARS, CARD_COLORS, CARD_ICONS, CARD_LIMITS, CardError, validateCard } from "../packages/core/src/members/widgets-card.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = cases.map((c) => {
  let error = null;
  try { validateCard(c.a2ui); } catch (e) { if (!(e instanceof CardError)) throw e; error = e.message; }
  let rendered = null;
  try { rendered = validateCard(c.a2ui, { checkLevels: false }); } catch (e) { if (!(e instanceof CardError)) throw e; }
  return { ...c, result: error ?? "ok", ...(rendered ? { rendered } : {}) };
});
writeFileSync(join(root, "packages/core/test/fixtures/widget-cards.json"),
  `${JSON.stringify({ generated: "tools/gen-widget-cards.mjs", limits: CARD_LIMITS, icons: CARD_ICONS, colors: CARD_COLORS, avatars: CARD_AVATARS, cases: out }, null, 1)}\n`);

import assert from "node:assert/strict";
import { test } from "node:test";
import { auditToolSurface } from "./tool-surface";

const ash = ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"];
const device = "lab_phone__calendar_create";

test("AR5 detector accepts exactly five stable ash tools and unrelated DSH tools", () => {
  assert.deepEqual(auditToolSurface(["bash", ...ash], ["bash", ...ash], [device]), []);
});

test("AR5 detector rejects an absent capture and an absent fake device catalogue", () => {
  assert.match(auditToolSurface([], ash, [device]).join(" "), /capture is empty/);
  assert.match(auditToolSurface(ash, ash, []).join(" "), /no fake device aliases/);
});

test("AR5 detector rejects missing and extra ash tools", () => {
  assert.match(auditToolSurface(ash.slice(1), ash, [device]).join(" "), /differs from the five-tool contract/);
  assert.match(auditToolSurface(ash, [...ash, "ash_timer_set"], [device]).join(" "), /differs from the five-tool contract/);
});

test("AR5 detector rejects direct device projection and duplicate aliases", () => {
  assert.match(auditToolSurface(ash, [...ash, device], [device]).join(" "), /projects device tool/);
  assert.match(auditToolSurface([...ash, "ash_send"], ash, [device]).join(" "), /duplicate names/);
});

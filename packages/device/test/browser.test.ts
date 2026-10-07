import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, EGO_CAPABILITY } from "../src/browser";

test("browser scripts are actions, persist per-caller task spaces and spill long output to a readable path", async () => {
  assert.equal(EGO_CAPABILITY.effect, "act");
  const dir = await mkdtemp(join(tmpdir(), "ash-browser-")), scripts: string[] = []; let space = 40;
  const run = async (script: string) => {
    scripts.push(script);
    const marker = script.match(/console\.log\("(ash-space-[^"]+)"/);
    return marker ? marker[1] + ++space : script.includes("LONG") ? "x".repeat(70000) : "page result";
  };
  let browser = new Browser(dir, "fixture", run);
  assert.equal((await browser.call({ task: "search", script: "console.log(await task.page('p1').snapshot())" }, "agent:a")).ok, true);
  assert.match(scripts[1], /taskSpace\(41\)/);
  browser = new Browser(dir, "fixture", run);
  await browser.call({ task: "search", script: "console.log('continued')" }, "agent:a");
  assert.match(scripts[2], /taskSpace\(41\)/);
  await browser.call({ task: "search", script: "console.log('other')" }, "agent:b");
  assert.match(scripts[4], /taskSpace\(42\)/);
  const result = await browser.call({ task: "search", script: "// LONG", finish: true }, "agent:a");
  const data = result.data as { path: string; truncated: boolean };
  assert.equal(data.truncated, true); assert.equal((await readFile(data.path, "utf8")).length, 70000);
  assert.match(scripts.at(-1)!, /finish\(\{keep:\[\]\}\)/);
  assert.equal((await browser.call({ task: "a", script: "", dangerous: true }, "agent:a")).ok, false);
});

test("failed scripts do not echo source or replay the action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ash-browser-failure-")); let actions = 0;
  const browser = new Browser(dir, "fixture", async script => {
    const marker = script.match(/console\.log\("(ash-space-[^"]+)"/);
    if (marker) return marker[1] + "7";
    actions++; throw new Error("SECRET_SOURCE");
  });
  const result = await browser.call({ task: "write", script: "SECRET_SOURCE" }, "agent:a");
  assert.equal(result.ok, false); assert.equal(actions, 1); assert.doesNotMatch(JSON.stringify(result), /SECRET_SOURCE/);
});

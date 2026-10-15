import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { withBrowser } from "./support.js";

async function fixture(browser) {
  const web = new URL("../../", import.meta.url);
  const html = await readFile(new URL("index.html", web), "utf8");
  const css = (await Promise.all(["ash-tokens.css", "ash-ui.css"].map(path => readFile(new URL(path, web), "utf8")))).join("\n") + [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  const bundle = await build({ stdin: { contents: 'export { WindowView, changedIds } from "./window-view.js"; export { ScrollPosition } from "./scroll-position.js"; export { appendConversation } from "./conversation.js"; export * as Cards from "./a2ui-card.js";', resolveDir: fileURLToPath(new URL("js/", web)) }, bundle: true, write: false, format: "iife", globalName: "ViewModule" });
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, reducedMotion: "reduce" });
  await page.setContent(`<style>${css}body{display:block;height:852px}#log{height:740px}</style><main id="log" class="stream"></main><button id="outside">outside</button>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => {
    window.view = new ViewModule.WindowView(document.querySelector("#log"));
    window.say = (id, text = `message ${id}`) => ({ id: `m${id}`, seq: id, ts: Date.now() + id * 1000, type: "say", side: "agent", from: "agent:main", text, group: "t1", reactions: [] });
    window.options = { primary: "agent:main", agentName: id => id.slice(6), atStart: false };
  });
  return page;
}

test(...withBrowser("tail shrinkage clamping before resize compensation preserves a jump, while genuine wheel scrolling releases it", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    view.dispose();
    const root = document.querySelector("#log");
    root.style.cssText = "height:200px;display:block;padding:0;overflow-y:auto;gap:0";
    const leading = document.createElement("div"), target = document.createElement("div"), tail = document.createElement("div");
    leading.style.height = "1000px"; target.style.height = "173px"; target.dataset.rowKey = "target"; tail.style.height = "27px";
    root.replaceChildren(leading, target, tail);
    window.position = new ViewModule.ScrollPosition(root);
    // Hold back resize compensation to reproduce the browser's scroll event arriving first.
    position.observer.disconnect(); position.jump(target);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = root.scrollTop;
    const scrolled = new Promise(resolve => root.addEventListener("scroll", event => resolve({ compensation: position.compensations.has(event), pending: position.pendingJump === target, bottom: position.anchor.bottom }), { once: true }));
    tail.remove();
    const clamped = root.scrollTop;
    const event = await scrolled;
    target.style.height = "800px";
    position.restore();
    const rowTop = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, clamped, rowTop, ...event };
  });
  assert.equal(result.before - result.clamped, 27, "actual DOM shrinkage clamps scrollTop");
  assert.deepEqual([result.compensation, result.pending, result.bottom], [true, true, false]);
  assert.ok(Math.abs(result.rowTop) < 1, "later growth must keep the requested row rather than follow the tail");
  const bounds = await page.locator("#log").boundingBox();
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => !position.pendingJump);
  assert.equal(await page.evaluate(() => position.anchor.bottom), true, "ordinary downward wheel scrolling to the end remains user intent");
  await page.evaluate(async () => {
    position.jump(document.querySelector('[data-row-key="target"]'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => !position.pendingJump);
  assert.equal(await page.evaluate(() => position.anchor.bottom), false, "ordinary upward scrolling also releases the jump");
}));

test(...withBrowser("a jump near the history tail stays on the target as its table grows", async ({ browser }) => {
  const page = await fixture(browser);
  const top = await page.evaluate(async () => {
    options.atLatest = true; options.fullTexts = new Map();
    const target = { ...say(21, "table summary"), full: "tail-table" };
    const items = [...Array.from({ length: 20 }, (_, i) => say(i + 1)), target, say(22)];
    view.update(items, [], options); await view.settled(); view.jump(target.id);
    // Layout can deliver an unchanged scroll event after the jump's compensation event.
    document.querySelector("#log").dispatchEvent(new Event("scroll"));
    document.querySelector("#log").dispatchEvent(new Event("scroll"));
    // Exercise incremental layout on a slow device, including the first slice that makes the target alignable.
    view.markdown.budget = 0;
    options.fullTexts.set(target.full, "| Row | Value |\n| --- | --- |\n" + Array.from({ length: 140 }, (_, i) => `| Row ${i} | Complete value |`).join("\n"));
    view.update(items, [], options, new Set([target.id])); await view.settled();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.querySelector('.msg[data-seq="21"]').getBoundingClientRect().top - document.querySelector("#log").getBoundingClientRect().top;
  });
  assert.ok(Math.abs(top) < 2, `the explicit target became a bottom-following anchor (${top}px)`);
}));

test(...withBrowser("stable rows preserve Markdown, card drafts, selection, and the original sibling layout", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    const custom = { id: "choice", seq: 2, ts: Date.now(), type: "card", side: "agent", card: { type: "options", prompt: "choose", options: [{ id: "a", text: "A" }], allow_custom: true } };
    options.onSelect = async () => {};
    window.items = [say(1, "## Heading\n\nread **this**\n\n```js\nlet a=1;\n```"), custom];
    view.update(items, [], options); await view.settled();
    const first = document.querySelector('.msg[data-seq="1"]'), paragraph = first.querySelector("p");
    const input = document.querySelector(".card-custom"); input.value = "unfinished"; input.focus(); input.setSelectionRange(2, 5);
    items.push(say(3)); view.update(items, [], options, new Set(["m3"])); await view.settled();
    const draft = input === document.activeElement && input.value === "unfinished" && input.selectionStart === 2 && input.selectionEnd === 5;
    document.querySelector("#outside").focus();
    const selection = document.getSelection(), range = document.createRange(); range.selectNodeContents(paragraph); selection.removeAllRanges(); selection.addRange(range);
    items.push(say(4)); view.update(items, [], options, new Set(["m4"])); await view.settled();
    const keptSelection = selection.toString();
    items[0] = { ...items[0], text: "changed while selected" }; view.update(items, [], options, new Set(["m1"])); await view.settled();
    const deferred = first.querySelector("p") === paragraph;
    selection.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); await Promise.resolve(); await view.settled();
    const changed = document.querySelector('.msg[data-seq="1"]').textContent;
    const eager = document.createElement("div"); ViewModule.appendConversation(eager, items, options);
    const normalize = root => [...root.children].map(node => { const clone = node.cloneNode(true); clone.removeAttribute("data-row-key"); clone.classList.remove("enter"); return clone.outerHTML; });
    return { draft, keptSelection, deferred, changed, layout: normalize(document.querySelector("#log")), eager: normalize(eager), markdownSurvived: first.querySelector("p") === paragraph };
  });
  assert.equal(result.draft, true); assert.equal(result.keptSelection, "read this"); assert.equal(result.deferred, true);
  assert.match(result.changed, /changed while selected/); assert.deepEqual(result.layout, result.eager);
}));

test(...withBrowser("a pushed card is patched in its row: the field being typed in keeps its instance, caret and composition, and the mini app is not loaded again", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    const acts = [], says = [];
    const wait = (test) => new Promise(resolve => { const timer = setInterval(() => { if (test()) { clearInterval(timer); resolve(); } }, 20); });
    const card = (updated_at, temp, name = "") => ({ id: "m2", seq: 2, ts: Date.now(), type: "card", side: "agent", card: { type: "a2ui", id: "c-live", owner: "agent:main", app: "weather", state: "open", life: "active", updated_at,
      plan: { root: "root", data: { name }, components: [
        { id: "root", component: "Column", children: ["temp", "name", "html"] },
        { id: "temp", component: "Text", text: temp },
        { id: "name", component: "TextField", label: "名字", bind: "/name", text: "" },
        // The page's own script: one call (with someone else's card id in its body), then a send with the answer.
        { id: "html", component: "Html", height: 60, html: "<script>ash.call('app:weather','now',{card:'other'}).then(function(r){ash.send('got',{text:r.text,origin:String(location.origin)})})</script>" }] } } });
    options.a2ui = { act: async (body) => { acts.push(body); return { state: "ok", text: "21°" }; }, say: async (to, text, data) => { says.push(data); }, draft: async () => ({}) };
    window.items = [say(1), card(1, "20°")];
    view.update(items, [], options); await view.settled();
    const frame = document.querySelector("iframe.a2-html");
    await wait(() => says.length > 0);
    let loads = 0; frame.addEventListener("load", () => loads++);
    const input = document.querySelector(".a2ui input.a2-input"), root = document.querySelector(".a2ui");
    input.focus(); input.value = "ab"; input.dispatchEvent(new Event("input")); input.setSelectionRange(1, 2);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    const next = card(2, "21°", "hub");
    ViewModule.Cards.patchA2uiCard(next.card);
    items[1] = next; view.update(items, [], options, new Set(["m2"])); await view.settled();
    items.push(say(3)); view.update(items, [], options, new Set(["m3"])); await view.settled();
    await new Promise(resolve => setTimeout(resolve, 300));
    return { sameRoot: document.querySelector(".a2ui") === root, sameInput: document.querySelector(".a2ui input.a2-input") === input, focused: document.activeElement === input,
      value: input.value, selection: [input.selectionStart, input.selectionEnd], temp: document.querySelector('[data-a2-id="temp"]').textContent, loads,
      sameFrame: document.querySelector("iframe.a2-html") === frame, sandbox: frame.getAttribute("sandbox"), acts, says };
  });
  assert.deepEqual([result.sameRoot, result.sameInput, result.focused, result.sameFrame], [true, true, true, true]);
  assert.equal(result.value, "ab", "the owner's typing stays (and wins over the hub's value)");
  assert.deepEqual(result.selection, [1, 2]);
  assert.equal(result.temp, "21°", "the live text follows");
  assert.equal(result.loads, 0, "the mini app is not loaded again");
  assert.equal(result.sandbox, "allow-scripts");
  assert.deepEqual(result.acts, [{ card: "c-live", component: "html", data: { name: "" }, request: { call: { member: "app:weather", word: "now", body: { card: "other" } } } }], "who presses is the frame's card");
  assert.deepEqual(result.says[0], { id: "c-live", action: "got", context: { text: "21°", origin: "null" }, data: { name: "" } }, "answered over the bridge, from an opaque origin");
}));

test(...withBrowser("receipt, reaction, and burst grouping updates retain the message body and attachment nodes", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    let files = 0; options.onOpenFile = () => files++;
    const owner = { ...say(1), side: "owner", text: "hello", delivery: "sent", attachments: [{ workspace: "main", path: "a.png", name: "a.png" }] };
    window.items = [owner, say(2, "## Title\n\nkeep body")]; view.update(items, [], options); await view.settled();
    const body = document.querySelector('.msg[data-seq="2"]'), paragraph = body.querySelector("p"), attachment = document.querySelector(".atts button");
    items = [{ ...owner, delivery: "read", revision: 2 }, { ...items[1], reactions: [{ id: "r", emoji: "👍" }], revision: 2 }, say(3)];
    view.update(items, [], options, new Set(["m1", "m2", "m3"])); await view.settled(); attachment.click();
    return { sameBody: body === document.querySelector('.msg[data-seq="2"]'), sameParagraph: paragraph === body.querySelector("p"), sameAttachment: attachment === document.querySelector(".atts button"), files, receipt: document.querySelector(".delivery").textContent, reaction: body.querySelector(".reaction").textContent, group: body.className };
  });
  assert.equal(result.sameBody, true); assert.equal(result.sameParagraph, true); assert.equal(result.sameAttachment, true);
  assert.equal(result.files, 1); assert.equal(result.receipt, "已读"); assert.equal(result.reaction, "👍"); assert.match(result.group, /group-first/);
}));

test(...withBrowser("explicit full-text expansion replaces its focused button while selected text remains protected", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    options.fullTexts = new Map();
    window.items = [{ ...say(1, "summary"), full: "source" }];
    let finish;
    options.onExpand = () => new Promise(resolve => { finish = () => {
      options.fullTexts.set("source", "## Full text\n\ncomplete body");
      const control = document.querySelector(".expand"); control.disabled = false; control.focus();
      view.update(items, [], options, new Set(["m1"])); resolve();
    }; });
    view.update(items, [], options);
    const more = document.querySelector(".expand"); more.focus(); more.click(); finish();
    await view.settled('m1');
    const expanded = document.querySelector(".markdown").textContent;
    const paragraph = document.querySelector(".markdown p");
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    options.fullTexts.set("source", "replacement while selected"); view.update(items, [], options, new Set(["m1"]));
    return { expanded, more: document.querySelector(".expand") !== null, selected: selection.toString(), sameParagraph: paragraph === document.querySelector(".markdown p") };
  });
  assert.match(result.expanded, /Full textcomplete body/);
  assert.equal(result.more, false); assert.equal(result.selected, "complete body"); assert.equal(result.sameParagraph, true);
}));

test(...withBrowser("prepend, append, eviction, delayed heights and long-message blocks keep the reading anchor", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(async () => { window.items = Array.from({ length: 60 }, (_, i) => say(i + 100)); view.update(items, [], options); await view.settled(); view.position.jump(document.querySelector('.msg[data-seq="130"]')); window.anchor = document.querySelector('.msg[data-seq="130"]'); window.offset = anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top; });
  const measure = () => page.evaluate(() => anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset);
  await page.evaluate(async () => { items = [...Array.from({ length: 10 }, (_, i) => say(i + 90)), ...items]; view.update(items, [], options); await view.settled(); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(async () => { items.push(say(160)); view.update(items, [], options, new Set(["m160"])); await view.settled(); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(async () => { items = items.slice(10); view.update(items, [], options); await view.settled(); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(async () => { const space = document.createElement("div"); space.style.height = "800px"; document.querySelector('.msg[data-seq="110"]').append(space); });
  await page.waitForFunction(() => Math.abs(anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset) < 1);
  await page.evaluate(async () => { items = [say(1000, Array.from({ length: 80 }, (_, i) => `paragraph ${i}\n`).join("\n"))]; view.update(items, [], options); await view.settled(); window.anchor = document.querySelectorAll(".markdown p")[40]; view.position.jump(anchor); window.offset = anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top; const space = document.createElement("div"); space.style.height = "300px"; document.querySelector(".markdown").prepend(space); });
  await page.waitForFunction(() => Math.abs(anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset) < 1);
  await page.evaluate(async () => { view.position.latest(); items.push(say(1001)); view.update(items, [], options, new Set(["m1001"])); await view.settled(); });
  assert.ok(await page.evaluate(() => view.root.scrollHeight - view.root.scrollTop - view.root.clientHeight < 1));
}));

test(...withBrowser("eviction respects focus and late attachment reads revoke their resources", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(async () => {
    window.released = 0; options.openInline = () => new Promise(resolve => { window.finishAttachment = resolve; });
    window.items = [{ ...say(1), attachments: [{ source: "inline", message_id: "m1", index: 0, name: "image.png" }] }];
    view.update(items, [], options); await view.settled(); document.querySelector(".atts button").click();
    const bubble = document.querySelector(".msg"); bubble.tabIndex = 0; bubble.focus();
    view.update([], [], options); await view.settled(); window.pins = view.pinnedIds(); document.querySelector("#outside").focus();
    finishAttachment({ preview: true, name: "image", url: "blob:unused", revoke: () => released++ });
  });
  await page.waitForFunction(() => released === 1);
  assert.deepEqual(await page.evaluate(() => pins), ["m1"]);
  assert.equal(await page.locator("#log .atts").count(), 0);
  const reset = await page.evaluate(async () => {
    view.update([say(2, "old source")], [], { ...options, epoch: 1 }); await view.settled();
    const old = document.querySelector(".msg"); old.tabIndex = 0; old.focus();
    view.update([say(2, "new source")], [], { ...options, epoch: 2 }); await view.settled();
    return { oldConnected: old.isConnected, text: document.querySelector(".msg").textContent, pins: view.pinnedIds() };
  });
  assert.equal(reset.oldConnected, false); assert.equal(reset.text, "new source"); assert.deepEqual(reset.pins, []);
  const settled = await page.evaluate(async () => {
    options.onAnswerAsk = async () => {};
    const question = { id: "q", seq: 4, ts: Date.now(), type: "ask", side: "agent", ask: { id: "q", from: "agent:main", title: "question", state: "pending", allow_custom: true, expires_at: Date.now() + 60000, options: [] } };
    view.update([question], [], options); await view.settled(); document.querySelector(".card-custom").focus();
    view.update([{ ...question, ask: { ...question.ask, state: "answered", choice: "custom", answer_text: "done" } }], [], options, new Set(["q"])); await view.settled();
    return { inputs: document.querySelectorAll(".card-custom").length, outcome: document.querySelector(".ask-outcome")?.textContent };
  });
  assert.equal(settled.inputs, 0); assert.match(settled.outcome, /done/);
}));

test(...withBrowser("history window facts render failures, aggregate reactions and one authoritative introduction", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    const retries = [];
    const failed = { id: "t-failed", type: "failed", seq: 3, ts: Date.now(), turn: "t-failed", retry: { text: "try again" } };
    const items = [{ ...say(2), byte_size: 100, reactions: [{ emoji: "👍", count: 10000 }] }, failed];
    const settings = { ...options, intro: true, previous: { ...say(1), text: undefined }, onRetry: async item => retries.push(item.id) };
    view.update(items, [], settings); await view.settled();
    const bubble = document.querySelector(".msg"), paragraph = bubble.querySelector("p");
    const introductions = document.querySelectorAll(".intro").length;
    const group = bubble.className;
    await document.querySelector(".failure button").click();
    const jump = view.jump("t-failed");
    view.update([{ ...items[0], byte_size: 101, reactions_more: true, reactions: [{ emoji: "👍", count: 10001 }] }, failed], [], { ...settings, atStart: true, intro: false }, new Set(["m2"])); await view.settled();
    return { introductions, finalIntroductions: document.querySelectorAll(".intro").length, failures: document.querySelectorAll(".failure").length,
      retries, jump, group, sameParagraph: paragraph === document.querySelector(".msg p"), reaction: document.querySelector(".reaction").textContent,
      sameBubble: bubble === document.querySelector(".msg") };
  });
  assert.equal(result.introductions, 1); assert.equal(result.finalIntroductions, 0); assert.equal(result.failures, 1);
  assert.deepEqual(result.retries, ["t-failed"]); assert.equal(result.jump, true); assert.match(result.group, /group-last/);
  assert.equal(result.sameParagraph, true); assert.equal(result.sameBubble, true); assert.equal(result.reaction, "👍 10001");
}));

test(...withBrowser("expansion releases its button focus, keeps complete selectable DOM and shows progress", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(async () => {
    window.source = '|key|value|\n|---|---|\n' + Array.from({ length: 1550 }, (_, i) => `|row ${i}|**value** ${i}|`).join('\n') + '\n\n```js\nconst final = "copy me";\n```';
    options.fullTexts = new Map();
    window.items = [{ ...say(1, 'preview text'), full: 'hash-1' }];
    options.onExpand = async (hash, id) => {
      window.receivedId = id;
      options.fullTexts.set(hash, source);
      view.update(items, [], options, new Set([id]));
      await view.settled(id);
    };
    view.update(items, [], options); await view.settled();
  });
  await page.locator('.expand').focus(); await page.locator('.expand').click();
  await page.waitForFunction(() => document.querySelector('.msg small')?.textContent === '正在展开…');
  await page.evaluate(async () => { await view.settled('m1'); });
  const result = await page.evaluate(() => {
    const bubble = document.querySelector('.msg');
    const selection = getSelection(), range = document.createRange(); range.selectNodeContents(bubble.querySelector('.markdown')); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString(); selection.removeAllRanges();
    const expected = document.createElement('div'); ViewModule.appendConversation(expected, items, options);
    return { receivedId, rows: bubble.querySelectorAll('tbody tr').length, progress: Boolean(bubble.querySelector('small')), expand: Boolean(bubble.querySelector('.expand')), same: bubble.querySelector('.markdown').outerHTML === expected.querySelector('.markdown').outerHTML, selected, borders: getComputedStyle(bubble.querySelector('table')).borderCollapse };
  });
  assert.equal(result.receivedId, 'm1'); assert.equal(result.rows, 1550);
  assert.equal(result.progress, false); assert.equal(result.expand, false); assert.equal(result.same, true);
  assert.match(result.selected, /row 1549/); assert.match(result.selected, /copy me/); assert.equal(result.borders, 'collapse');
}));

test(...withBrowser("shared frame work cancels evicted/old-source Markdown and retains body on metadata updates", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    const text = '|key|value|\n|---|---|\n' + Array.from({ length: 1550 }, (_, i) => `|${i}|**value ${i}**|`).join('\n');
    window.items = [say(1, text), say(2, text), say(3, text)];
    view.update(items, [], options);
    const old = document.querySelector('.msg[data-seq="1"]'), pending = view.settled();
    const queueBefore = view.markdown.jobs.length;
    view.update([say(4, 'new dataset')], [], { ...options, epoch: 'new' });
    await pending; await view.settled();
    const canceledNodes = old.querySelectorAll('tr').length;
    const body = document.querySelector('.msg'), paragraph = body.querySelector('p');
    view.update([{ ...say(4, 'new dataset'), reactions: [{ emoji: '👍', count: 4 }] }], [], { ...options, epoch: 'new' });
    await view.settled();
    return { queueBefore, canceledNodes, detached: !old.isConnected, same: paragraph === body.querySelector('p'), jobs: view.markdown.jobs.length, text: body.textContent };
  });
  assert.equal(result.queueBefore, 3); assert.equal(result.canceledNodes, 0); assert.equal(result.detached, true);
  assert.equal(result.same, true); assert.equal(result.jobs, 0); assert.match(result.text, /new dataset/);
}));

test(...withBrowser("partial long-message work is serial and cancellable while the reading anchor stays fixed", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(async () => {
    window.items = Array.from({ length: 50 }, (_, i) => say(i + 1));
    items[0] = { ...items[0], full: 'long-a' }; items[1] = { ...items[1], full: 'long-b' };
    options.fullTexts = new Map(); view.update(items, [], options); await view.settled();
    window.anchor = document.querySelector('.msg[data-seq="30"]'); view.position.jump(anchor);
    window.offset = anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top;
    const text = '|key|value|\n|---|---|\n' + Array.from({ length: 1550 }, (_, i) => `|${i}|**value ${i}**|`).join('\n');
    options.fullTexts.set('long-a', text); options.fullTexts.set('long-b', text);
    view.update(items, [], options, new Set(['m1', 'm2']));
  });
  await page.waitForFunction(() => { const count = document.querySelector('.msg[data-seq="1"]').querySelectorAll('tbody tr').length; return count > 0 && count < 1550; });
  const mid = await page.evaluate(() => {
    const first = document.querySelector('.msg[data-seq="1"]');
    const before = first.querySelectorAll('tr').length, second = document.querySelector('.msg[data-seq="2"]').querySelectorAll('tr').length;
    const controller = view.rows.get('message:m1').lifetime.controller;
    items[0] = { ...items[0], reactions: [{ emoji: '👍', count: 2 }] };
    view.update(items, [], options, new Set(['m1']));
    const sameJob = controller === view.rows.get('message:m1').lifetime.controller;
    view.cancelExpansion('m1');
    return { before, second, sameJob, offset: anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset };
  });
  assert.equal(mid.second, 0); assert.equal(mid.sameJob, true); assert.ok(Math.abs(mid.offset) < 1);
  await page.evaluate(async () => { await view.settled(); });
  const after = await page.evaluate(() => ({ count: document.querySelector('.msg[data-seq="1"]').querySelectorAll('tr').length, second: document.querySelector('.msg[data-seq="2"]').querySelectorAll('tbody tr').length, offset: anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset }));
  assert.equal(after.count, mid.before); assert.equal(after.second, 1550); assert.ok(Math.abs(after.offset) < 1);
}));

test(...withBrowser("automatic full-text slices pause with the live scroll gate and settle when canceled", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(async () => {
    window.allowBuild = false;
    options.shouldBuild = () => allowBuild;
    options.fullTexts = new Map([['restored', '|key|value|\n|---|---|\n' + Array.from({ length: 1550 }, (_, i) => `|${i}|**value** ${i}|`).join('\n')]]);
    window.items = [{ ...say(1, 'preview'), full: 'restored' }, say(2, 'inline during scrolling')];
    view.update(items, [], options);
    window.completed = false; view.settled('m1').then(() => { completed = true; });
    await view.settled('m2');
  });
  assert.equal(await page.locator('.msg[data-seq="1"] tbody tr').count(), 0);
  assert.match(await page.locator('.msg[data-seq="1"]').textContent(), /preview.*正在展开/s);
  assert.match(await page.locator('.msg[data-seq="2"]').textContent(), /inline during scrolling/);
  assert.equal(await page.evaluate(() => completed), false);
  await page.evaluate(() => { allowBuild = true; });
  await page.waitForFunction(() => document.querySelector('.msg[data-seq="1"] tbody tr'));
  const paused = await page.evaluate(() => { allowBuild = false; return document.querySelectorAll('.msg[data-seq="1"] tbody tr').length; });
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await page.locator('.msg[data-seq="1"] tbody tr').count(), paused);
  await page.evaluate(async () => { view.cancelExpansion('m1'); await view.settled('m1'); });
  assert.equal(await page.evaluate(() => completed), true);
  assert.equal(await page.locator('.msg[data-seq="1"] tbody tr').count(), paused);
  await page.evaluate(async () => { allowBuild = true; view.update(items, [], options, new Set(['m1'])); await view.settled('m1'); });
  assert.equal(await page.locator('.msg[data-seq="1"] tbody tr').count(), 1550, "a canceled body must rebuild even when its source and hash did not change");
  const selected = await page.evaluate(() => { const body = document.querySelector('.msg[data-seq="1"] table'); const range = document.createRange(); range.selectNodeContents(body); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
  assert.match(selected, /1549/);
}));

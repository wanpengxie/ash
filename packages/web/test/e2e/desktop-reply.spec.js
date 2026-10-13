import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function fixture(page, text) {
  const source = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const bundled = await build({ stdin: { contents: 'import {DesktopWork} from "./desktop-work.js"; window.DesktopWork=DesktopWork;', resolveDir: fileURLToPath(new URL('../../js', import.meta.url)) }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? bundled.outputFiles[0].text : `<meta name="viewport" content="width=device-width,initial-scale=1">${source.match(/<style>[\s\S]*?<\/style>/)[0]}<section id="desktopWork"></section><script type="module" src="/fixture.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.DesktopWork);
  await page.evaluate(text => {
    window.net = { endpoint: location.origin, currentScope: 'owner-one', connectionId: 'connectionId-one' };
    const root = document.createElement('div'), input = document.createElement('textarea');
    root.className = 'desktop-control'; root.append(input);
    window.control = { root, draftInput: input, items: () => [], update: () => root };
    window.reader = new DesktopWork(document.getElementById('desktopWork'), net, { control });
    reader.opened = true; reader.target = { device_id: 'device:one', node_id: 'one', endpoint_id: 'one', authorization_generation: 1, authorization_revision: 'a'.repeat(64) };
    reader.work = { node_id: 'one', endpoint_id: 'one', kind: 'conversation', native_id: 'thread-one' };
    reader.entry = { page: { items: [{ turn_id: 'turn', messages: [{ source_message_id: 'reply', role: 'assistant', text, material_refs: [] }, { source_message_id: 'user', role: 'user', text: '**用户原文** [链接](https://example.com)', material_refs: [] }] }] } };
    reader.render('已同步');
  }, text);
  return async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
}

test.use({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
test('phone reply permits web links, offers exact local result links and keeps executable markup inert', async ({ page }) => {
  const requests = [];
  page.on('request', request => { if (request.url().includes('reply-tracker.invalid')) requests.push(request.url()); });
  const code = '  第一行\n第二行 <tag>';
  const text = '# 回复\n\n[网页](https://example.com/help) [邮件](mailto:hello@example.com)\n\n[坏链接](javascript:alert%281%29) [文件](file:///tmp/a) [数据](data:text/html,hello) [本机](/Users/me/report.pdf)\n\n![图片](https://reply-tracker.invalid/image)\n\n<script>window.executed=true</script><img src=x onerror="window.executed=true">\n\n```text\n'+code+'\n```';
  const close = await fixture(page, text);
  try {
    const reply = page.locator('.desktop-assistant');
    await expect(reply.locator('h1')).toHaveText('回复');
    await expect(reply.locator('a')).toHaveCount(4);
    await expect(reply.locator('a[href="https://example.com/help"]')).toHaveAttribute('target', '_blank');
    await expect(reply.locator('a[href="https://example.com/help"]')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(reply.locator('script,img,iframe,svg:not(.i)')).toHaveCount(0);
    await expect(reply.locator('.md-file-link')).toHaveCount(1);
    expect(await page.evaluate(() => window.executed)).toBeUndefined(); expect(requests).toEqual([]);
    await expect(page.locator('.desktop-user .desktop-text')).toHaveText('**用户原文** [链接](https://example.com)');
    await expect(page.locator('.desktop-user a,.desktop-user .markdown')).toHaveCount(0);
    await expect(reply.getByRole('button')).toHaveCount(1);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } }); });
    await reply.getByRole('button', { name: '复制代码' }).tap();
    expect(await page.evaluate(() => window.copied)).toBe(code);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } }); document.execCommand = command => { window.fallback = [command, document.querySelector('.md-copy-buffer').value]; return true; }; });
    await reply.getByRole('button', { name: '复制代码' }).tap();
    expect(await page.evaluate(() => window.fallback)).toEqual(['copy', code]);
    await expect(page.locator('.md-copy-buffer')).toHaveCount(0);
    await page.route('https://example.com/help', route => route.fulfill({ body: '<p>external page</p>' }));
    await page.locator('.desktop-control textarea').fill('回来继续输入');
    const popupPromise = page.waitForEvent('popup'); await reply.getByRole('link', { name: '网页', exact: true }).tap();
    const popup = await popupPromise; await popup.close();
    await expect(page.locator('.desktop-control textarea')).toHaveValue('回来继续输入');
  } finally { await close(); }
});

test('phone long code and tables scroll locally; polling preserves selection and updates changed content', async ({ page }) => {
  const text = '长按选择这段回复\n\n| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |\n\n```\n'+'long_code_'.repeat(70)+'\n```';
  const close = await fixture(page, text);
  try {
    const sizes = await page.locator('.desktop-assistant').evaluate(el => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, row: el.getBoundingClientRect().width, pre: el.querySelector('pre').clientWidth, code: el.querySelector('pre').scrollWidth, table: el.querySelector('.md-table-wrap').clientWidth, cells: el.querySelector('.md-table-wrap').scrollWidth }));
    expect(sizes.page).toBeLessThanOrEqual(sizes.viewport); expect(sizes.row).toBeLessThan(sizes.viewport);
    expect(sizes.code).toBeGreaterThan(sizes.pre); expect(sizes.cells).toBeGreaterThan(sizes.table);
    await page.evaluate(() => {
      window.rowBefore = document.querySelector('.desktop-assistant'); window.historyBefore = document.querySelector('.desktop-messages');
      const text = rowBefore.querySelector('p').firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4); document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
      reader.entry.page.items[0].messages.push({ source_message_id: 'reply-new', role: 'assistant', text: '新回复', material_refs: [] }); reader.render('已同步', { newMessages: true });
    });
    expect(await page.evaluate(() => [document.getSelection().toString(), document.querySelector('.desktop-assistant') === rowBefore, document.querySelector('.desktop-messages') === historyBefore])).toEqual(['长按选择', true, true]);
    await expect(page.locator('.desktop-new')).toBeVisible();
    await page.evaluate(() => { reader.entry.page.items[0].messages[0].text = '已更新正文'; reader.render('已同步'); });
    await expect(page.locator('.desktop-assistant').first()).toHaveText('已更新正文');
    expect(await page.evaluate(() => document.querySelector('.desktop-assistant') === rowBefore)).toBe(false);
    expect(await page.evaluate(() => { const row = document.querySelector('.desktop-assistant'); reader.entry.page.items[0].messages[0].material_refs = [{ kind: 'image' }]; reader.render('已同步'); return row !== document.querySelector('.desktop-assistant'); })).toBe(true);
    for (const boundary of ['scope', 'connectionId', 'work', 'target']) {
      expect(await page.evaluate(boundary => { const previous = document.querySelector('.desktop-messages'); if (boundary === 'scope') net.currentScope = 'owner-two'; if (boundary === 'connectionId') net.connectionId = 'connectionId-two'; if (boundary === 'work') reader.work = { ...reader.work, native_id: 'thread-two' }; if (boundary === 'target') reader.target = { ...reader.target, authorization_revision: 'b'.repeat(64) }; reader.render('已同步'); return previous !== document.querySelector('.desktop-messages'); }, boundary)).toBe(true);
    }
  } finally { await close(); }
});

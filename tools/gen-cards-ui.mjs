#!/usr/bin/env node
// 「卡片」应用的页面（packages/apps/cards/ui/home.html）：自己带齐一切的一个文件（沙箱 WebView 里引不到主页面的任何东西）：
// 令牌（亮 / 暗，主题跟 hostContext.theme）+ ash-ui.css + 页面自己的 home.css + 页面代码 home.js（放在 <head>）+ home.html。
//   node tools/gen-cards-ui.mjs          生成（改了 ui/src 或 packages/web 的样式以后跑；产物要提交）
//   node tools/gen-cards-ui.mjs --check  不写文件，产物和源对不上就以 1 退出
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensCss } from "./gen-vitals-ui.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const ui = "packages/apps/cards/ui";

export function pages() {
  const css = [tokensCss(), read("packages/web/ash-ui.css"), read(`${ui}/src/home.css`)].map((s) => s.trim()).join("\n");
  const home = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<title>卡片</title>
<style>
${css}
</style>
<script>
${read(`${ui}/src/home.js`).trim().replaceAll("</script", "<\\/script")}
</script>
</head>
<body>
${read(`${ui}/src/home.html`).trim()}
</body>
</html>
`;
  return { "home.html": home };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [file, text] of Object.entries(pages())) {
    const path = join(root, ui, file);
    if (check) { if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`${ui}/${file} is not what gen-cards-ui produces`); stale = true; } }
    else writeFileSync(path, text);
  }
  if (stale) process.exit(1);
}

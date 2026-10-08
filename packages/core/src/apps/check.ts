// apps.validate: everything install would trip over, said precisely enough to fix without guessing. Static checks read the
// folder; the trial run starts the server once (ASH_TRIAL=1, no usable credential), lists its tools and reads every page.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deviceWordSpec } from "../../../sdk/src/words";
import { ajvFor } from "../world/router";
import { APP_ID_PATTERN, APP_SCHEMA, validateManifest, type AppManifest } from "./schema";

export interface AppProblem { level: "error" | "warning"; where: string; problem: string; fix?: string }
export interface AppSpawnSpec { command: string; args: string[]; env: Record<string, string>; cwd?: string }
export const UI_MIME = "text/html;profile=mcp-app";
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const ID = new RegExp(APP_ID_PATTERN);

const error = (where: string, problem: string, fix?: string): AppProblem => ({ level: "error", where, problem, ...(fix ? { fix } : {}) });
const warning = (where: string, problem: string, fix?: string): AppProblem => ({ level: "warning", where, problem, ...(fix ? { fix } : {}) });
const short = (value: unknown, max = 300) => String(value instanceof Error ? value.message : value).replace(/\s+/g, " ").trim().slice(0, max);

/** One schema error as a sentence about the field it is on. */
function schemaProblem(item: ErrorObject): AppProblem | null {
  const at = `app.json ${item.instancePath || "/"}`;
  const p = item.params as Record<string, unknown>;
  switch (item.keyword) {
    case "required": return error(at, `缺少必填字段 ${p.missingProperty}`);
    case "additionalProperties": return error(at, `不认识的字段 ${p.additionalProperty}（ash-app/1 不允许多余字段）`, "删掉它，或看 apps.contract 里的字段表");
    case "const": return error(at, `必须是 ${JSON.stringify(p.allowedValue)}`);
    case "type": return error(at, `类型应为 ${p.type}`);
    case "enum": return error(at, `只能是 ${JSON.stringify(p.allowedValues)} 之一`);
    case "pattern": return error(at, `格式不对，要匹配 ${p.pattern}`);
    case "minLength": return error(at, p.limit === 1 ? "不能为空" : `至少 ${p.limit} 个字符`);
    case "maxLength": return error(at, `最多 ${p.limit} 个字符`);
    case "minItems": return error(at, `至少 ${p.limit} 项`);
    case "maxItems": return error(at, `最多 ${p.limit} 项`);
    case "maxProperties": return error(at, `最多 ${p.limit} 个`);
    case "not": return /\/server\/env/.test(item.instancePath) || item.schemaPath.includes("propertyNames")
      ? error(at, "环境变量名不能以 ASH_ 开头（那是 Ash 给的）") : error(at, "app.card、app.activity 是 Ash 内置的事件，不用也不能在 events 里声明");
    case "propertyNames": return null;
    case "oneOf": return /^\/needs\/\d+$/.test(item.instancePath)
      ? error(at, "这一项不是合法的 need", '每项是 {"member":"device:phone","words":["…"],"why":"…"}、{"notify":true,"why":"…"}、{"card":true,"why":"…"} 或 {"widgets":true,"why":"…"} 之一，why 必填')
      : error(at, item.message ?? "不合规");
    default: return error(at, item.message ?? "不合规");
  }
}

let compiled: ReturnType<Ajv["compile"]> | null = null;
/** app.json as written: parse, schema (every error, by field), and the rules a schema cannot say. */
export function checkManifest(text: string, folder: string): { manifest: AppManifest | null; problems: AppProblem[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (cause) { return { manifest: null, problems: [error("app.json", `不是合法的 JSON：${short(cause)}`)] }; }
  compiled ??= new Ajv({ strict: false, allErrors: true }).compile(APP_SCHEMA);
  const problems: AppProblem[] = [];
  if (!compiled(raw)) {
    const errors = compiled.errors ?? [];
    // Inside a need that matches no variant, the per-variant complaints are noise: the oneOf sentence says it all.
    const needs = new Set(errors.filter((item) => item.keyword === "oneOf" && /^\/needs\/\d+$/.test(item.instancePath)).map((item) => item.instancePath));
    for (const item of errors) {
      if ([...needs].some((path) => item.instancePath.startsWith(path) && item.keyword !== "oneOf")) continue;
      const problem = schemaProblem(item);
      if (problem && !problems.some((known) => known.where === problem.where && known.problem === problem.problem)) problems.push(problem);
    }
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (typeof record.id === "string" && record.id !== folder) problems.push(error("app.json /id", `id 是 ${record.id}，但文件夹叫 ${folder}`, `两者要相同：把文件夹放在 /root/apps/${record.id}/`));
  if (!ID.test(folder)) problems.push(error("文件夹", `文件夹名 ${folder} 不是合法的应用 id（${APP_ID_PATTERN}）`));
  if (problems.length) return { manifest: null, problems };
  const checked = validateManifest(raw);
  const wake = !checked.ok && /^wake_events (\S+) is not in events$/.exec(checked.error);
  if (wake) return { manifest: null, problems: [error("app.json /wake_events", `${wake[1]} 没有写在 events 里`, "wake_events 里的每个事件都要先在 events 里声明")] };
  if (!checked.ok) return { manifest: null, problems: [error("app.json", ({ "duplicate surface id": "surfaces 里有重复的 id", "each member or kind of need appears once": "needs 里同一个成员（或 notify/card/widgets）只能出现一次", "an app does not need itself": "needs 里不能写自己（app:<自己的 id>）" } as Record<string, string>)[checked.error] ?? checked.error)] };
  const manifest = checked.manifest;
  for (const surface of manifest.surfaces ?? []) if (!surface.resource.startsWith(`ui://${manifest.id}/`))
    problems.push(warning(`app.json surfaces ${surface.id}`, `resource ${surface.resource} 不在 ui://${manifest.id}/ 下`, `习惯写成 ui://${manifest.id}/${surface.id}`));
  return { manifest, problems };
}

/** The folder's files: app.json, the icon, the server's own file. */
export function checkFolder(dir: string, folder: string): { manifest: AppManifest | null; problems: AppProblem[] } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { manifest: null, problems: [error("文件夹", "这个文件夹不存在", "先用 apps.scaffold 生成，或自己建 /root/apps/<id>/")] };
  if (!existsSync(join(dir, "app.json"))) return { manifest: null, problems: [error("app.json", "文件夹里没有 app.json", "看 apps.contract 第 1 节，或用 apps.scaffold 生成")] };
  const { manifest, problems } = checkManifest(readFileSync(join(dir, "app.json"), "utf8"), folder);
  if (!manifest) return { manifest, problems };
  if (!manifest.role) problems.push(warning("app.json /role", "没写 role：Ash 只能拿 summary 猜什么时候该用它",
    "写一句它管什么、什么时候用，例如「主人和 Ash 的待办：说到要做的事就记进来」"));
  if (!manifest.icon) problems.push(warning("app.json /icon", "没有图标：会显示默认图标", "放一个正方形 PNG（192×192 或更大）在文件夹里，icon 写它的文件名"));
  else {
    const file = join(dir, manifest.icon);
    if (!existsSync(file)) problems.push(warning("app.json /icon", `图标文件 ${manifest.icon} 不存在：会显示默认图标`));
    else {
      const bytes = readFileSync(file);
      const kind = extname(file).toLowerCase();
      const looks = kind === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : kind === ".webp" ? bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"
          : /<svg[\s>]/i.test(bytes.subarray(0, 2000).toString("utf8"));
      if (!looks) problems.push(warning("app.json /icon", `${manifest.icon} 的内容不是 ${kind.slice(1).toUpperCase()}`));
      if (bytes.length > 512 * 1024) problems.push(warning("app.json /icon", `图标有 ${Math.round(bytes.length / 1024)} KB，太大`, "控制在 512 KB 以内"));
      if (kind === ".svg") problems.push(warning("app.json /icon", "SVG 图标在手机上的「Ash 应用」里画不出来（它只认 PNG/WebP），会显示默认图标", "换成正方形 PNG，192×192 或更大"));
    }
  }
  // `node server.mjs`, `python3 app.py`: the script must be there (relative to the app folder).
  const script = manifest.server.args?.[0];
  if (/^(node|python3?|bun|deno)$/.test(manifest.server.command) && script && !script.startsWith("-") && /\.(m?js|cjs|ts|py)$/.test(script) && !script.startsWith("/") && !existsSync(join(dir, script)))
    problems.push(error("app.json /server", `server 要运行 ${script}，但文件夹里没有这个文件`));
  if (manifest.server.command.startsWith("./") && !existsSync(join(dir, manifest.server.command)))
    problems.push(error("app.json /server/command", `${manifest.server.command} 不存在`));
  return { manifest, problems };
}

/** Start the server once and look at what it offers: tools as ash would register them, every page as the shell reads it. */
export async function trialRun(manifest: AppManifest, spec: AppSpawnSpec, timeoutMs = 30_000): Promise<{ problems: AppProblem[]; tools: string[]; surfaces: string[] }> {
  const problems: AppProblem[] = [];
  const tools: string[] = [], surfaces: string[] = [];
  let stderr = "";
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, ...(spec.cwd ? { cwd: spec.cwd } : {}), stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-1500); });
  const output = () => stderr.trim() ? `；它最后的输出（stderr）：${short(stderr.trim().split("\n").slice(-6).join(" | "), 600)}` : "";
  const client = new Client({ name: "ash-check", version: "1.0.0" });
  try {
    try { await client.connect(transport, { timeout: timeoutMs }); }
    catch (cause) {
      problems.push(error("server", `服务没有启动起来，或没有按 MCP 回答 initialize：${short(cause)}${output()}`,
        "Ash 在应用文件夹里运行 server.command server.args…，stdin/stdout 上每行一条 JSON-RPC 2.0；stdout 只能写协议消息，日志写 stderr。对照 apps.contract 第 2 节或 apps.scaffold 生成的 server.mjs"));
      return { problems, tools, surfaces };
    }
    const capabilities = client.getServerCapabilities() ?? {};
    let listed: { name: string; title?: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }[] = [];
    try { listed = (await client.listTools(undefined, { timeout: timeoutMs })).tools as typeof listed; }
    catch (cause) { problems.push(error("server tools/list", `tools/list 失败：${short(cause)}${output()}`, capabilities.tools ? undefined : "initialize 的回答里 capabilities 要有 tools: {}")); }
    const seen = new Set<string>();
    let writes = 0;
    for (const tool of listed) {
      const where = `工具 ${short(tool.name, 80)}`;
      if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) { problems.push(warning(where, "名字不合规，不会登记成能力", "名字要匹配 ^[a-z][a-z0-9_.-]{0,63}$，例如 notes.add")); continue; }
      if (seen.has(tool.name)) { problems.push(warning(where, "名字重复，只登记第一个")); continue; }
      seen.add(tool.name);
      const schema = tool.inputSchema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as { type?: unknown }).type !== "object") {
        problems.push(warning(where, "inputSchema 必须是 type 为 object 的 JSON Schema，否则不会登记", '没有参数就写 {"type":"object","properties":{},"additionalProperties":false}'));
        continue;
      }
      try { deviceWordSpec({ name: tool.name, description: tool.description || tool.name, label: tool.title || tool.name, risk: "none", input_schema: schema as never }); ajvFor(schema); }
      catch (cause) { problems.push(warning(where, `inputSchema 编译不过（Ajv 严格模式），不会登记：${short(cause)}`)); continue; }
      tools.push(tool.name);
      if (!(tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true)) writes++;
      if (!tool.title) problems.push(warning(where, "没有 title：审批卡上会直接显示工具名", "写一个中文动宾短语，如「记一笔」"));
      if (!tool.description) problems.push(warning(where, "没有 description：Agent 不知道它做什么"));
      if (!tool.annotations || typeof tool.annotations.readOnlyHint !== "boolean")
        problems.push(warning(where, "没写 annotations.readOnlyHint：会当作「改数据」记账", "只读的工具写 annotations: {readOnlyHint: true}，改数据的写 false"));
      const linked = (tool._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
      if (typeof linked === "string" && !(manifest.surfaces ?? []).some((item) => item.resource === linked))
        problems.push(warning(where, `_meta.ui.resourceUri 指向 ${short(linked, 120)}，但 app.json 的 surfaces 里没有这个页面`));
    }
    // Every app is an organ of ash: what the owner can do with its data on a page, the agent can do through its tools.
    const pages = (manifest.surfaces ?? []).length > 0;
    if (!tools.length && !problems.some((item) => item.where === "server tools/list"))
      problems.push((pages ? error : warning)("server tools/list", pages ? `只有页面、没有可用的工具：Agent 没法通过 app:${manifest.id} 看或改它的数据`
        : `一个工具都没有：Agent 没法通过 app:${manifest.id} 用它`, "每个应用都要有给 Agent 用的工具：读数据的（readOnlyHint: true）和改数据的（readOnlyHint: false），页面也通过它们读写"));
    else if (pages && tools.length && !writes)
      problems.push(warning("server tools/list", "只有只读工具：页面上能改的数据，Agent 改不了", "页面上每种改数据的操作都写成一个工具（readOnlyHint: false），页面用 app.call 调它，Agent 用同一个"));
    for (const surface of manifest.surfaces ?? []) {
      const where = `页面 ${surface.id}（${surface.resource}）`;
      let read: Awaited<ReturnType<Client["readResource"]>>;
      try { read = await client.readResource({ uri: surface.resource }, { timeout: timeoutMs }); }
      catch (cause) { problems.push(error(where, `resources/read 读不出来：${short(cause)}${output()}`, capabilities.resources ? "服务要对这个 uri 返回 {contents:[{uri, mimeType, text}]}" : "initialize 的回答里 capabilities 要有 resources: {}，并实现 resources/read")); continue; }
      const content = (read.contents ?? []).find((item) => item.uri === surface.resource) ?? read.contents?.[0];
      const html = !content ? "" : typeof (content as { text?: unknown }).text === "string" ? String((content as { text: string }).text)
        : typeof (content as { blob?: unknown }).blob === "string" ? Buffer.from(String((content as { blob: string }).blob), "base64").toString("utf8") : "";
      if (!content || !html.trim()) { problems.push(error(where, "返回的内容是空的", "contents[0].text 放整页 HTML")); continue; }
      surfaces.push(surface.id);
      if (content.mimeType !== UI_MIME) problems.push(warning(where, `mimeType 是 ${short(content.mimeType ?? "（没写）", 80)}`, `写 ${UI_MIME}`));
      if (/localStorage\.setItem|indexedDB\.open/.test(html)) problems.push(warning(where, "页面把数据存在浏览器里（localStorage / IndexedDB）：Agent 看不到也改不了",
        "主人的数据放在服务里（如 data.json），页面和 Agent 都通过工具读写；浏览器里只放页面自己的小状态"));
      if (!/ui\/initialize/.test(html)) problems.push(warning(where, "页面没有发 ui/initialize：调不了工具，也跟不上深浅色", "用 apps.scaffold 生成的 ui/app.js（window.app.call）"));
    }
  } finally {
    try { await client.close(); } catch { /* already gone */ }
  }
  return { problems, tools, surfaces };
}

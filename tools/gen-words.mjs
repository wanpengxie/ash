#!/usr/bin/env node
// Generates the word list from its source:
//   packages/sdk/schema/words.json   for the web client, Kotlin and the docs
//   docs/WORDS.md                    the list for people
// Source of truth: packages/sdk/src/words.ts (service, owner and agent words) and packages/sdk/src/namespaces.ts
// (standard hand actions). Run `npm run gen:words`; with --check it writes nothing and fails when
// the files in the repository differ from what the source generates.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORD_CONTRACTS } from "../packages/sdk/src/words.ts";
import { standardContracts } from "../packages/sdk/src/namespaces.ts";
import { ERROR_CODES, ERROR_MEANINGS } from "../packages/sdk/src/message.ts";
import { API_VERSION, ASH_SDK, WORD_CONTRACT_VERSION } from "../packages/sdk/src/versions.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

// The order of SPEC-02 §4.1, then the owner's and agents' words, apps, then the hand and body actions.
const MEMBER_ORDER = ["service:admin", "service:health", "service:gate", "service:vault", "service:devices", "service:link", "service:agents", "service:apps", "service:clock", "service:tasks", "service:llm",
  "service:persona", "service:widgets", "service:pulse", "service:cost", "service:reflex", "service:senses", "service:directory", "service:history", "service:blobs",
  "service:host", "service:bodies", "person:owner", "agent:*", "app:*", "device:*", "body:*"];
const rank = (member) => { const at = MEMBER_ORDER.indexOf(member); return at < 0 ? MEMBER_ORDER.length : at; };

export function build() {
  const words = [...WORD_CONTRACTS, ...standardContracts()]
    .map((word, at) => ({ word, at })).sort((a, b) => rank(a.word.member) - rank(b.word.member) || a.at - b.at).map(({ word }) => word);
  const hash = createHash("sha256").update(canonical(words)).digest("hex");
  const json = `${JSON.stringify({
    generated: "tools/gen-words.mjs", sdk: ASH_SDK, word_contract: WORD_CONTRACT_VERSION, api: API_VERSION, hash,
    error_codes: ERROR_CODES, words,
  }, null, 1)}\n`;
  return { json, markdown: markdown(words, hash) };
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const fields = (schema) => {
  const names = new Set();
  const required = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const name of Object.keys(node.properties ?? {})) names.add(name);
    for (const name of node.required ?? []) required.add(name);
    for (const key of ["anyOf", "oneOf", "allOf"]) for (const branch of node[key] ?? []) visit(branch);
  };
  visit(schema);
  const secret = new Set(Object.entries(schema?.properties ?? {}).filter(([, child]) => child && child["x-ash-secret"]).map(([name]) => name));
  return [...names].map((name) => `${name}${required.has(name) ? "*" : ""}${secret.has(name) ? " (secret)" : ""}`).join(", ") || "-";
};
const flags = (word) => [
  word.kind === "event" ? `event ${word.direction}` : null, word.record ? "record" : null, word.local_only ? "local_only" : null,
  word.foreground ? "foreground" : null, word.per_call_risk ? "per_call_risk" : null, word.timeout_ms ? `timeout ${word.timeout_ms / 1000}s` : null,
].filter(Boolean).join(", ") || "-";

function markdown(words, hash) {
  const members = [...new Set(words.map((word) => word.member))];
  const lines = [
    "# 词清单", "",
    `> 由 \`tools/gen-words.mjs\` 从 \`packages/sdk/src/words.ts\` 和 \`namespaces.ts\` 生成，不要手改。词契约 v${WORD_CONTRACT_VERSION}，${API_VERSION}，ASH_SDK ${ASH_SDK}，内容哈希 \`${hash.slice(0, 16)}\`。`,
    "> 机器可读的完整契约（输入输出 JSON Schema）在 `packages/sdk/schema/words.json`。", "",
    "表头：调用方 = 契约里的 `callers`（owner 主人、agent、app 应用、kernel 中枢自己）；effect / risk 见 SPEC-01 §6.2；输入里 `*` 是必填。`agent:*` 是每个已声明的 agent，`device:*`、`body:*` 是手和身体上的标准能力，`app:*` 是每个应用。", "",
    "## 目录", "",
    ...members.map((member) => `- [\`${member}\`](#${member.replace(/[^a-z0-9*-]/g, "").replace(/\*/g, "")}) (${words.filter((word) => word.member === member).length})`), "",
    "## 错误码", "",
    "| 码 | 意思 |", "|---|---|",
    ...ERROR_CODES.map((code) => `| \`${code}\` | ${cell(ERROR_MEANINGS[code])} |`), "",
  ];
  for (const member of members) {
    lines.push(`## \`${member}\``, "");
    lines.push("| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |", "|---|---|---|---|---|---|---|");
    for (const word of words.filter((item) => item.member === member)) {
      lines.push(`| \`${word.word}\` | ${word.callers.join(", ")} | ${word.effect} / ${word.risk} | ${cell(flags(word))} | ${cell(fields(word.input_schema))} | ${cell(word.label.doing)} | ${cell(word.description)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const targets = (built) => [
  [join(root, "packages/sdk/schema/words.json"), built.json],
  [join(root, "docs/WORDS.md"), built.markdown],
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = build();
  if (process.argv.includes("--check")) {
    const stale = targets(built).filter(([path, text]) => { try { return readFileSync(path, "utf8") !== text; } catch { return true; } });
    if (stale.length) {
      console.error(`stale generated files (run: node --import tsx tools/gen-words.mjs):\n${stale.map(([path]) => `  ${path}`).join("\n")}`);
      process.exit(1);
    }
  } else for (const [path, text] of targets(built)) writeFileSync(path, text);
}

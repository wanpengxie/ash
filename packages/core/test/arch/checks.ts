import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type Finding = { rule: "AR1" | "AR2" | "AR3" | "AR4" | "AR12"; file: string; detail: string };
type Tree = Record<string, string>;
const allowedRoutes = new Set(["POST /api/send", "GET /api/stream", "GET /api/describe", "GET /api/workspaces/:ws/files", "PUT /api/workspaces/:ws/files"]);
const primaryTerm = String.fromCharCode(65, 116, 111, 108, 108);

function filesUnder(root: string): Tree {
  const out: Tree = {};
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory() && e.name === "build" && dir === root) visit(join(full, "evidence"));
      else if (e.isDirectory()) visit(full);
      else if (e.isFile() && /\.(?:[cm]?[jt]sx?|md|json|ya?ml|html|css|sh|log|txt|csv)$/.test(e.name)) out[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  visit(root);
  return out;
}

function source(file: string, value: string) { return ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function walk(n: ts.Node, visit: (n: ts.Node) => void) { visit(n); ts.forEachChild(n, c => walk(c, visit)); }
function lineOf(sf: ts.SourceFile, n: ts.Node) { return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1; }
function stringValue(n: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text;
  return undefined;
}
function classifyUrl(raw: string): boolean {
  const u = raw.replace(/^\.\//, "/").replace(/^\/?api\//, "/api/");
  return /^\/api\/(?:send|stream|describe)(?:\?|$)/.test(u) || /^\/api\/workspaces\/[^/]+\/files(?:\?|$)/.test(u);
}

/** Pure detector used by fixture tests and the final repository gate. Missing targets fail closed. */
export function checkTree(tree: Tree, terms: string[] = [primaryTerm]): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: Finding["rule"], file: string, detail: string) => findings.push({ rule, file, detail });
  const names = Object.keys(tree);
  const core = "packages/core/src/";
  const members = names.filter(f => f.startsWith(core + "members/") && /\.[jt]sx?$/.test(f));
  if (!members.length) add("AR1", core + "members/", "member sources missing");
  for (const file of members) {
    const sf = source(file, tree[file]);
    walk(sf, n => {
      let spec: string | undefined;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) spec = n.moduleSpecifier && stringValue(n.moduleSpecifier);
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(sf) === "require")) spec = n.arguments[0] && stringValue(n.arguments[0]);
      if (!spec) return;
      if (!spec.startsWith(".")) {
        if (!builtinModules.includes(spec) && !builtinModules.includes(spec.replace(/^node:/, ""))) add("AR1", file, `line ${lineOf(sf, n)}: member import outside world/sdk/self ${spec}`);
        return;
      }
      const target = resolve("/repo", file, "..", spec).replace("/repo/", "");
      const ownPath = file.slice((core + "members/").length);
      const own = ownPath.split("/")[0].replace(/\.[jt]sx?$/, "").split("-")[0];
      const sameMember = target.startsWith(core + `members/${own}/`) || new RegExp(`^${core}members/${own}(?:-|\\.[jt]sx?$)`).test(target);
      if (target.startsWith(core + "members/") && !sameMember) add("AR1", file, `line ${lineOf(sf, n)}: cross-member import ${spec}`);
      else if (!target.startsWith(core + "world/") && !target.startsWith("packages/sdk/") && !sameMember) add("AR1", file, `line ${lineOf(sf, n)}: member import outside world/sdk/self ${spec}`);
    });
  }

  const ui = names.filter(f => /^packages\/core\/ui\/js\/.*\.js$/.test(f));
  if (!ui.length) add("AR2", "packages/core/ui/js/", "UI JavaScript sources missing");
  for (const file of ui) {
    const sf = source(file, tree[file]);
    walk(sf, n => {
      if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
      const called = n.expression.getText(sf);
      if (!["fetch", "EventSource", "window.fetch", "new EventSource"].includes(called) && !called.endsWith(".fetch")) return;
      const arg = n.arguments?.[0];
      const url = arg && stringValue(arg);
      if (!url || !classifyUrl(url)) add("AR2", file, `line ${lineOf(sf, n)}: unapproved or dynamic request URL ${arg?.getText(sf) ?? "<missing>"}`);
    });
  }

  const server = core + "server.ts";
  if (!tree[server]) add("AR3", server, "edge router source missing");
  else {
    const sf = source(server, tree[server]);
    const found = new Set<string>();
    walk(sf, n => {
      if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && /^(GET|PUT|POST|DELETE|PATCH) \/api\//.test(n.expression.text)) found.add(n.expression.text);
      if (ts.isRegularExpressionLiteral(n) && /api\\?\//.test(n.text) && /workspaces/.test(n.text)) found.add("GET /api/workspaces/:ws/files");
    });
    for (const route of found) if (!allowedRoutes.has(route)) add("AR3", server, `unapproved route ${route}`);
    for (const route of ["POST /api/send", "GET /api/stream", "GET /api/describe"]) if (!found.has(route)) add("AR3", server, `required route missing ${route}`);
    if (!found.size) add("AR3", server, "no API routes discoverable; update route extractor for new router shape");
  }

  const workers = names.filter(f => /packages\/core\/src\/(?:workers|flows)\/.*\.[jt]s$/.test(f));
  if (!workers.length) add("AR4", core + "workers/", "workers/flows sources missing");
  for (const file of workers) {
    const sf = source(file, tree[file]);
    walk(sf, n => {
      const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) ? n.moduleSpecifier && stringValue(n.moduleSpecifier) : ts.isCallExpression(n) && (n.expression.getText(sf) === "require" || n.expression.kind === ts.SyntaxKind.ImportKeyword) ? n.arguments[0] && stringValue(n.arguments[0]) : undefined;
      if (spec && /^(?:node:)?(?:fs|fs\/promises)$/.test(spec)) add("AR4", file, `line ${lineOf(sf, n)}: filesystem import ${spec}`);
    });
  }
  for (const file of names.filter(f => f.startsWith(core) && /\.[jt]s$/.test(f) && f !== core + "members/self.ts")) {
    const value = tree[file];
    if (/(?:SOUL|IDENTITY|USER|MEMORY|HEARTBEAT|PROACTIVE)\.md|\.ash\/(?:versions|staging)|memory\//.test(value) && /(?:writeFile|appendFile|rename|copyFile|mkdir|unlink|rmSync|createWriteStream)\s*\(/.test(value)) add("AR4", file, "possible direct intrinsic file write outside self member");
  }

  const activeTerms = terms.filter(Boolean);
  if (!activeTerms.length) add("AR12", "<terms>", "private terminology list is empty");
  for (const [file, value] of Object.entries(tree)) {
    for (const term of activeTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "iu");
      if (pattern.test(value)) add("AR12", file, `prohibited term found (${term.length} characters)`);
    }
  }
  return findings;
}

export function checkRepository(root: string, privateTermsFile?: string): Finding[] {
  const terms = [primaryTerm];
  if (privateTermsFile) terms.push(...readFileSync(privateTermsFile, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")));
  else return [{ rule: "AR12", file: "<terms>", detail: "ASH_ARCH_PRIVATE_TERMS_FILE is required for final gate" }, ...checkTree(filesUnder(root), terms)];
  return checkTree(filesUnder(root), terms);
}

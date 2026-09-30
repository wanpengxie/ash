import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AgentPort } from "../../packages/core/src/runtime";
import { requestText, startHarness, type ScriptedReply, waitForTurn } from "./harness";

const plans: { label: string; call: Extract<ScriptedReply, { tool: string }> }[] = [];
const harness = await startHarness((request) => {
  if (request.tools.length === 0) return "helper";
  const last = request.messages.at(-1);
  if (Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === "tool_result")) return "done";
  const plan = plans.shift();
  assert.ok(plan, `unexpected model call: ${requestText(request).slice(-100)}`);
  return plan.call;
});

try {
  const workspace = join(harness.dir, "workspace");
  const managed = join(workspace, "managed");
  mkdirSync(managed, { recursive: true });
  const protectedPath = join(managed, "SOUL.md");
  const alias = join(workspace, "alias.md");
  const danglingAlias = join(workspace, "future-alias.md");
  const directoryAlias = join(workspace, "managed-alias");
  const safePath = join(workspace, "notes.txt");
  writeFileSync(protectedPath, "original\n");
  symlinkSync(protectedPath, alias);
  symlinkSync(join(managed, "FUTURE.md"), danglingAlias);
  symlinkSync(managed, directoryAlias);

  const canonical = (raw: string) => {
    const target = resolve(workspace, raw);
    if (existsSync(target)) return realpathSync(target);
    try {
      if (lstatSync(target).isSymbolicLink()) return null;
    } catch { /* new file: resolve its existing parent */ }
    return join(realpathSync(dirname(target)), basename(target));
  };
  const isManaged = (path: string) => {
    const rel = relative(realpathSync(managed), path);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  };

  const pre: { tool: string; path: string; caller: string; denied: boolean }[] = [];
  const post: { tool: string; path: string; caller: string; isError: boolean; resultPath?: string }[] = [];
  const resultEvents: { tool: string; path: string; caller: string; isError: boolean }[] = [];
  const port = { agentId: "agent:main", contextSections: () => ({ identity: "File hook probe", state: "" }), projectedCapabilities: () => [], onCapabilitiesChanged: () => () => {}, gateStep: () => ({ allow: true }), gateTool: async () => ({ allow: true }) } as unknown as AgentPort;
  const host = harness.host;
  host.ctx.on("tools/pre-execute", async (exec: { name: string; arguments: unknown; agent?: object }, next: () => Promise<{ kind: string }>) => {
    if (exec.name !== "write" && exec.name !== "edit") return next();
    const raw = (exec.arguments as { file_path?: string }).file_path;
    assert.equal(typeof raw, "string");
    const path = canonical(raw!);
    const caller = host.portOf(exec.agent)?.agentId ?? "unmapped";
    const denied = path === null || isManaged(path);
    pre.push({ tool: exec.name, path: path ?? raw!, caller, denied });
    return denied ? { kind: "deny", reason: "Managed file: use the file service request instead." } : next();
  });
  host.ctx.on("tools/post-execute", async (exec: { name: string; arguments: unknown; agent?: object }, result: { isError: boolean; value?: { path?: string } }, next: () => Promise<{ kind: string }>) => {
    if (exec.name === "write" || exec.name === "edit") post.push({ tool: exec.name, path: (exec.arguments as { file_path: string }).file_path, caller: host.portOf(exec.agent)?.agentId ?? "unmapped", isError: result.isError, resultPath: result.value?.path });
    return next();
  });
  host.ctx.on("tools/result", (exec: { name: string; arguments: unknown; agent?: object }, result: { isError: boolean }) => {
    if (exec.name === "write" || exec.name === "edit") resultEvents.push({ tool: exec.name, path: (exec.arguments as { file_path: string }).file_path, caller: host.portOf(exec.agent)?.agentId ?? "unmapped", isError: result.isError });
  });

  const { agent, sessionId } = await host.agent(port, workspace);
  async function run(label: string, call: Extract<ScriptedReply, { tool: string }>) {
    plans.push({ label, call });
    const result = await waitForTurn(host, sessionId, () => agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: label }], source: { kind: "user" } }));
    assert.equal(result.text, "done");
  }
  await run("blocked direct write", { tool: "write", input: { file_path: protectedPath, content: "replaced\n" } });
  await run("allowed ordinary write", { tool: "write", input: { file_path: safePath, content: "ordinary\n" } });
  await run("blocked direct edit", { tool: "edit", input: { file_path: protectedPath, old_string: "original", new_string: "changed" } });
  await run("blocked symlink alias", { tool: "write", input: { file_path: alias, content: "alias overwrite\n" } });
  await run("blocked new managed file", { tool: "write", input: { file_path: join(managed, "NEW.md"), content: "new\n" } });
  await run("blocked dangling symlink alias", { tool: "write", input: { file_path: danglingAlias, content: "new\n" } });
  await run("blocked directory symlink alias", { tool: "write", input: { file_path: join(directoryAlias, "OTHER.md"), content: "new\n" } });

  assert.equal(readFileSync(protectedPath, "utf8"), "original\n");
  assert.equal(readFileSync(safePath, "utf8"), "ordinary\n");
  assert.equal(existsSync(join(managed, "NEW.md")), false);
  assert.equal(existsSync(join(managed, "FUTURE.md")), false);
  assert.equal(existsSync(join(managed, "OTHER.md")), false);
  assert.deepEqual(pre.map((x) => x.denied), [true, false, true, true, true, true, true]);
  assert.ok(pre.every((x) => x.caller === "agent:main"));
  assert.equal(post.length, 7);
  assert.equal(resultEvents.length, 7);
  assert.deepEqual(post.map((x) => x.isError), [true, false, true, true, true, true, true]);
  assert.deepEqual(resultEvents.map((x) => x.isError), [true, false, true, true, true, true, true]);
  console.log("PASS: pre-execute observed write/edit file_path and mapped caller agent:main; denied six managed targets before mutation, including file, directory, and dangling symlinks");
  console.log("PASS: ordinary file write succeeded; protected file stayed unchanged");
  console.log(`PASS: post-execute and tools/result observed all seven outcomes; successful write result path present=${Boolean(post[1].resultPath)}`);
  console.log("NEGATIVE CONTROL: post-execute observed the allowed write only after its side effect; it cannot enforce managed-file ownership by itself");
  await run("shell bypass control", { tool: "bash", input: { command: "printf 'shell-write\\n' > managed/SOUL.md", description: "probe file write" } });
  assert.equal(readFileSync(protectedPath, "utf8"), "shell-write\n");
  assert.equal(pre.length, 7, "native file hook should not claim coverage of a shell write");
  console.log("NEGATIVE CONTROL: native write/edit hook did not intercept a shell command that changed the managed file; an independent filesystem boundary is required for full write enforcement");
} finally {
  await harness.close();
}

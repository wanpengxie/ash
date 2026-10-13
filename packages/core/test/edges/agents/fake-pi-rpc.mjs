// A stand-in for `pi --mode rpc` for the pi driver tests. It speaks pi's JSON-lines protocol on stdio and appends everything it is
// told (its start, each command) to the file FAKE_LOG as JSON lines, so a test can see what pi saw.
//   a prompt containing  SLOW   waits (400 ms, or until aborted)       CRASH  the process exits at once
//   TOOL   one tool call        THINK  a thinking block                 FAKE_CODEX=fail|auth|other|flaky   the Codex model answers with a network / login error
import { appendFileSync } from "node:fs";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
let provider = arg("--provider") ?? "deepseek";
let modelId = arg("--model") ?? "deepseek-flash";
const session = arg("--session-id");
let aborted = false;
let codexCalls = 0;
let release = null;
let steered = [];
const env = process.env;
log({ start: true, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: { HTTPS_PROXY: env.HTTPS_PROXY, HTTP_PROXY: env.HTTP_PROXY, NO_PROXY: env.NO_PROXY, ASH_TOKEN: env.ASH_TOKEN, KEY: env.DEEPSEEK_API_KEY ? "set" : "unset", DIR: env.PI_CODING_AGENT_DIR, OFFLINE: env.PI_OFFLINE } });

const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const respond = (cmd, data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }) });
const assistant = (content, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });

async function prompt(cmd) {
  const text = String(cmd.message ?? "");
  log({ prompt: text, images: (cmd.images ?? []).length, model: `${provider}/${modelId}`, session });
  if (text.includes("CRASH")) process.exit(1);
  aborted = false;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  if (text.includes("TOOL")) {
    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false });
  }
  if (text.includes("SLOW")) await new Promise((resolve) => { release = resolve; setTimeout(resolve, 400); });
  if (provider === "openai-codex" && (env.FAKE_CODEX === "fail" || env.FAKE_CODEX === "auth" || env.FAKE_CODEX === "other" || (env.FAKE_CODEX === "flaky" && ++codexCalls === 1))) {
    const errorMessage = env.FAKE_CODEX === "auth" ? "Could not parse your authentication token. Please try signing in again." : env.FAKE_CODEX === "other" ? "context length exceeded" : "fetch failed";
    out({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage }) });
  } else if (aborted) {
    out({ type: "message_end", message: assistant([], { stopReason: "aborted" }) });
  } else {
    const body = text.split("\n").filter((l) => l && !l.startsWith("[ash]")).pop() ?? text;
    const content = [];
    if (text.includes("THINK")) content.push({ type: "thinking", thinking: "hmm" });
    content.push({ type: "text", text: `echo[${provider}/${modelId}]: ${body}` });
    out({ type: "message_end", message: assistant(content) });
  }
  out({ type: "turn_end" });
  out({ type: "agent_end", willRetry: false });
  out({ type: "agent_settled", aborted });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type !== "prompt") log({ cmd: cmd.type, ...(cmd.type === "set_model" ? { provider: cmd.provider, modelId: cmd.modelId } : {}), ...(cmd.type === "steer" ? { message: cmd.message } : {}), ...(cmd.type === "set_thinking_level" ? { level: cmd.level } : {}) });
    switch (cmd.type) {
      case "get_state": respond(cmd, { model: { provider, id: modelId } }); break;
      case "set_model": provider = cmd.provider; modelId = cmd.modelId; respond(cmd, { provider, id: modelId }); break;
      case "prompt": respond(cmd, { disposition: "started" }); prompt(cmd); break;
      case "abort": aborted = true; release?.(); respond(cmd); break;
      case "steer": steered.push(cmd.message); respond(cmd, { disposition: "queued" }); break;
      case "compact": respond(cmd, { summary: "ok" }); break;
      default: respond(cmd, {});
    }
  }
});

// app:v2raya (ash-app/1): keeps v2rayA, the proxy of the container, running. MCP over stdio, written by hand, no packages.
//
// The server starts v2rayA as its child. When v2rayA ends, the server ends with a non-zero code and the hub restarts the whole
// app with its usual back-off. When the hub closes stdin or sends a signal, v2rayA is ended first, so no orphan is left.
//
//   v2raya.status  (read)  is it running, its pid, whether its two ports answer, the page of the owner
//   v2raya.logs    (read)  the end of the log file
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);
const DIR = "/opt/v2";
const ARGV = process.env.V2RAYA_ARGV ? JSON.parse(process.env.V2RAYA_ARGV) : [
  `${DIR}/v2raya`, "--lite", "--address", "127.0.0.1:2017", "--config", "/root/v2raya",
  "--v2ray-bin", `${DIR}/v2raya_core`, "--v2ray-assetsdir", `${DIR}/assets`, "--log-file", "/tmp/v2raya.log",
];
const LOG_FILE = process.env.V2RAYA_LOG || "/tmp/v2raya.log";
const PANEL_PORT = Number(process.env.V2RAYA_PANEL_PORT || 2017);
const PROXY_PORT = Number(process.env.V2RAYA_PROXY_PORT || 20171);

// ---- the child ----

let child = null;
let ending = false;
function stopChild() {
  if (!child) return;
  try { child.kill("SIGTERM"); } catch { /* gone */ }
}
function finish(code) {
  if (ending) return;
  ending = true;
  stopChild();
  // give it a moment to leave, then go
  setTimeout(() => process.exit(code), 300).unref();
  child?.once("exit", () => process.exit(code));
  if (!child) process.exit(code);
}
try {
  child = spawn(ARGV[0], ARGV.slice(1), { cwd: process.env.V2RAYA_CWD || "/root", stdio: ["ignore", "ignore", "pipe"] });
} catch (error) { console.error("v2raya: could not start:", error.message); process.exit(1); }
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { const line = chunk.split("\n").find((l) => l.trim()); if (line) console.error("[v2raya]", line.slice(0, 200)); });
child.on("error", (error) => { console.error("v2raya: could not start:", error.message); child = null; finish(1); });
child.on("exit", (code, signal) => { console.error(`v2raya: ended (${signal ?? code})`); child = null; finish(ending ? 0 : (code || 1)); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => finish(0));
process.on("exit", () => { try { child?.kill("SIGKILL"); } catch { /* gone */ } });

// ---- the tools ----

const portOpen = (port) => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  const end = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(1500, () => end(false));
  socket.once("connect", () => end(true));
  socket.once("error", () => end(false));
});

async function tool(name, args) {
  switch (name) {
    case "v2raya.status": {
      const [panel, proxy] = await Promise.all([portOpen(PANEL_PORT), portOpen(PROXY_PORT)]);
      return { running: !!child && child.exitCode === null, pid: child?.pid ?? null, panel_port_open: panel, proxy_port_open: proxy,
        panel_url: `http://127.0.0.1:${PANEL_PORT}`, proxy_url: `http://127.0.0.1:${PROXY_PORT}`, log_file: LOG_FILE,
        note: proxy ? "the proxy answers" : "the proxy port is closed: the owner has not yet imported a subscription and started a node in the panel" };
    }
    case "v2raya.logs": {
      const lines = Math.min(Math.max(Math.floor(Number(args.lines) || 100), 1), 1000);
      let text = "";
      try { text = readFileSync(LOG_FILE, "utf8"); } catch (error) { return { lines: [], note: `no log yet (${error.code ?? error.message})` }; }
      return { lines: text.split("\n").filter((l) => l !== "").slice(-lines) };
    }
    default: throw new Error("unknown tool " + name);
  }
}

// ---- MCP over stdio ----

const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOLS = [
  { name: "v2raya.status", title: "Status", description: "Is v2rayA running (pid), do its panel port (2017) and HTTP proxy port (20171) answer, and where the panel is.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "v2raya.logs", title: "Logs", description: "The end of v2rayA's log file (/tmp/v2raya.log).", inputSchema: object({ lines: { type: "number", description: "How many lines, default 100, at most 1000." } }), annotations: { readOnlyHint: true } },
];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("close", () => finish(0));
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "v2raya", version: "1.0.0" } } });
  else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    try {
      const data = await tool(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } });
    } catch (error) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error.message || error) }], isError: true } }); }
  } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method " + method } });
});

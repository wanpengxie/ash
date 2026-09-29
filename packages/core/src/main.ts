// ash core entry: `node ash-core.mjs --config ash.json`
//
// {
//   "space": "me",
//   "listen": "127.0.0.1:4700",
//   "stateDir": "/…/ash-core/state",
//   "workspaces": { "home": "/…/ash-home" },
//   "agents": [
//     { "id": "agent:main", "runtime": "dsh", "workspace": "home",
//       "dsh": { "url": "http://127.0.0.1:3090", "log": "/…/dsh-web.log", "patchFile": "/…/profiles/web/cordis.patch.yml" } }
//   ],
//   "notify": [ { "type": "http", "url": "http://127.0.0.1:3091/notify" } ]
// }
// Tokens live in <stateDir>/tokens.json (created on first start, mode 0600).

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core, type Notifier } from "./core";
import type { AgentRuntime } from "./runtime";
import { DshRuntime, type DshOptions } from "./runtimes/dsh";
import { EchoRuntime } from "./runtimes/echo";
import { startServer, type Tokens } from "./server";
import { Store } from "./store";

export interface Config {
  space?: string;
  listen?: string;
  stateDir: string;
  workspaces?: Record<string, string>;
  agents: { id: string; runtime: string; workspace?: string; dsh?: DshOptions }[];
  notify?: ({ type: "http"; url: string } | { type: "command"; argv: string[] })[];
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const token = () => randomBytes(24).toString("base64url");

function loadTokens(stateDir: string, agents: string[]): Tokens {
  const file = join(stateDir, "tokens.json");
  const t: Tokens = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { api: { [token()]: "person:owner" }, mcp: {} };
  for (const a of agents) t.mcp[a] ??= token();
  writeFileSync(file, JSON.stringify(t, null, 1), { mode: 0o600 });
  return t;
}

function notifiers(cfg: Config): Notifier[] {
  return (cfg.notify ?? []).map((n) =>
    n.type === "http"
      ? async ({ title, text }) => {
          await fetch(n.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, text }) });
        }
      : async ({ title, text }) => {
          const argv = n.argv.map((a) => a.replace("{title}", title).replace("{text}", text));
          spawn(argv[0], argv.slice(1), { stdio: "ignore" }).unref();
        },
  );
}

function runtimeFor(def: Config["agents"][number]): AgentRuntime {
  if (def.runtime === "dsh") {
    if (!def.dsh) throw new Error(`${def.id}: runtime dsh needs a "dsh" section`);
    return new DshRuntime(def.dsh);
  }
  if (def.runtime === "echo") return new EchoRuntime();
  throw new Error(`${def.id}: unknown runtime ${def.runtime} (this build has: dsh, echo)`);
}

export async function startCore(cfg: Config): Promise<{ core: Core; url: string; tokens: Tokens; close: () => Promise<void> }> {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const [host, portText] = (cfg.listen ?? "127.0.0.1:4700").split(":");
  const tokens = loadTokens(cfg.stateDir, cfg.agents.map((a) => a.id));
  const core = new Core(cfg.space ?? "me", new Store(join(cfg.stateDir, "ash.db")), notifiers(cfg), log);
  const server = await startServer(core, tokens, host, Number(portText));
  const addr = server.address();
  const url = `http://${host}:${typeof addr === "object" && addr ? addr.port : portText}`;
  log(`ash core (${cfg.space ?? "me"}) listening on ${url}`);
  for (const def of cfg.agents) {
    const ws = def.workspace ?? "home";
    const dir = cfg.workspaces?.[ws] ?? join(cfg.stateDir, "workspaces", ws);
    const agentState = join(cfg.stateDir, "agents", def.id.replace(":", "_"));
    mkdirSync(dir, { recursive: true });
    mkdirSync(agentState, { recursive: true });
    await core
      .addAgent(def.id, ws, runtimeFor(def), {
        agentId: def.id,
        workspaceDir: dir,
        stateDir: agentState,
        mcp: { url: `${url}/mcp/${def.id}`, headers: { "x-ash-token": tokens.mcp[def.id] } },
        log: (...a) => log(`[${def.id}]`, ...a),
      })
      .then(() => log(`${def.id} ready (${def.runtime})`))
      .catch((e) => log(`${def.id} failed to start:`, e instanceof Error ? e.message : e));
  }
  core.startTimers();
  return {
    core,
    url,
    tokens,
    close: async () => {
      await core.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && /ash-core|main\.[tj]s$/.test(process.argv[1])) {
  const i = process.argv.indexOf("--config");
  if (i < 0) {
    console.error("usage: ash-core --config <file>");
    process.exit(1);
  }
  startCore(JSON.parse(readFileSync(process.argv[i + 1], "utf8"))).catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}

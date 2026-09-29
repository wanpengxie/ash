// ash core entry: `node --expose-internals ash-core.mjs --config ash.json [--pair <code>]`
//
// Owner (the device that runs the agents — the Android phone, or any computer):
// {
//   "space": "me", "owner": "Wanpeng",
//   "listen": "127.0.0.1:4700",
//   "stateDir": "/…/ash/state",
//   "workspaces": { "home": "/…/ash-home" },
//   "dsh": { "root": "/…/node_modules/@deepseek-ai/dsh", "home": "/…/dsh-home", "patchFiles": [], "env": {} },
//   "agents": [ { "id": "agent:main", "name": "Ash", "runtime": "dsh", "workspace": "home", "grants": ["*"] } ],
//   "host": { "url": "http://127.0.0.1:4710", "token": "…", "coreToken": "…" },      // Android host bridge
//   "gateway": { "url": "https://ash-gateway.example.workers.dev" },                  // or set it in the UI
//   "policy": { "maxStepsPerTurn": 150, "quietHours": "23:00-07:00" },
//   "notify": [ { "type": "http", "url": "…" } | { "type": "command", "argv": ["notify-send", "{title}", "{text}"] } ]
// }
// Client (a laptop lending its MCP servers to the phone's agents through the gateway):
// { "role": "client", "name": "MacBook", "stateDir": "…", "gateway": { "url": "…" },
//   "mcp": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"] } } }
//
// Secrets never go to the log: tokens live in <stateDir>/tokens.json (0600), the UI URL in <stateDir>/ui-url.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DshHost, type DshHostOptions, DshRuntime, dshSettings } from "../../dsh-binding/src/index";
import { Core, OWNER, PHONE, type Notifier, type Policy } from "./core";
import { ClientLink, fileSigner, OwnerLink, type Signer } from "./gateway/link";
import { HostBridge, type HostOptions } from "./host";
import { McpCapabilities, type McpServerSpec } from "./mcpclient";
import type { AgentRuntime } from "./runtime";
import { EchoRuntime } from "./runtimes/echo";
import { Router, startServer, type Extensions, type Tokens } from "./server";
import { Store } from "./store";

export interface AgentDef {
  id: string;
  name?: string;
  runtime: string;
  workspace?: string;
  instructions?: string;
  /** Grants seeded on first start (e.g. ["*"] for the main agent). */
  grants?: string[];
}

export interface Config {
  role?: "owner" | "client";
  space?: string;
  owner?: string;
  name?: string;
  listen?: string;
  stateDir: string;
  workspaces?: Record<string, string>;
  dsh?: DshHostOptions;
  agents?: AgentDef[];
  host?: HostOptions & { coreToken?: string };
  gateway?: { url: string };
  policy?: Partial<Policy>;
  notify?: ({ type: "http"; url: string } | { type: "command"; argv: string[] })[];
  mcp?: Record<string, McpServerSpec>;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const token = () => randomBytes(24).toString("base64url");

function loadTokens(cfg: Config, agents: string[]): Tokens {
  const file = join(cfg.stateDir, "tokens.json");
  const t: Tokens = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { api: { [token()]: OWNER }, mcp: {} };
  for (const a of agents) t.mcp[a] ??= token();
  // The Android host speaks as the phone (owner-level on this device).
  for (const [k, m] of Object.entries(t.api)) if (m === PHONE) delete t.api[k];
  if (cfg.host?.coreToken) t.api[cfg.host.coreToken] = PHONE;
  writeFileSync(file, JSON.stringify(t, null, 1), { mode: 0o600 });
  return t;
}

function configNotifiers(cfg: Config): Notifier[] {
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

export interface Running {
  core: Core;
  url: string;
  tokens: Tokens;
  close: () => Promise<void>;
}

// ------------------------------------------------------------------ owner

export async function startOwner(cfg: Config): Promise<Running> {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const defs = cfg.agents ?? [];
  const tokens = loadTokens(cfg, defs.map((a) => a.id));
  const store = new Store(join(cfg.stateDir, "ash.db"));
  const core = new Core(cfg.space ?? "me", store, log, cfg.policy, cfg.owner ?? "owner");
  for (const n of configNotifiers(cfg)) core.addNotifier(n);

  const workspaces: Record<string, string> = { ...(cfg.workspaces ?? {}) };
  for (const d of defs) workspaces[d.workspace ?? "home"] ??= join(cfg.stateDir, "workspaces", d.workspace ?? "home");

  let dsh: DshHost | null = null;
  const ext: Extensions = { workspaces };
  const router = new Router(core, tokens, ext);
  const [host, portText] = (cfg.listen ?? "127.0.0.1:4700").split(":");
  const server = await startServer(router, host, Number(portText));
  const addr = server.address();
  const url = `http://${host}:${typeof addr === "object" && addr ? addr.port : portText}`;
  const ownerToken = Object.entries(tokens.api).find(([, m]) => m === OWNER)![0];
  writeFileSync(join(cfg.stateDir, "ui-url"), `${url}/?token=${ownerToken}\n`, { mode: 0o600 });
  log(`ash core (${core.space}) listening on ${url}; UI URL in ${join(cfg.stateDir, "ui-url")}`);

  // The Android host: the phone as a device, notifications, confirmations, wake-ups, Keystore.
  let bridge: HostBridge | null = null;
  if (cfg.host) {
    bridge = new HostBridge(core, cfg.host);
    for (let i = 0; ; i++) {
      try {
        await bridge.start();
        log("Android host connected");
        break;
      } catch (e) {
        if (i === 0) log("waiting for the Android host:", e instanceof Error ? e.message : e);
        if (i > 60) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // The DSH world (core only), booted once for every DSH agent.
  if (defs.some((d) => d.runtime === "dsh")) {
    if (!cfg.dsh) throw new Error(`runtime "dsh" needs a top-level "dsh" section`);
    dsh = new DshHost(cfg.dsh, log);
    await dsh.boot();
    ext.settings = dshSettings(dsh);
  }

  const runtimeFor = (def: AgentDef): AgentRuntime => {
    if (def.runtime === "dsh") return new DshRuntime(dsh!);
    if (def.runtime === "echo") return new EchoRuntime();
    throw new Error(`${def.id}: unknown runtime ${def.runtime} (this build has: dsh, echo)`);
  };
  for (const def of defs) {
    const ws = def.workspace ?? "home";
    const dir = workspaces[ws];
    const agentState = join(cfg.stateDir, "agents", def.id.replace(":", "_"));
    mkdirSync(dir, { recursive: true });
    mkdirSync(agentState, { recursive: true });
    if (def.instructions && !existsSync(join(dir, "AGENTS.md"))) writeFileSync(join(dir, "AGENTS.md"), def.instructions);
    const seeded = `grants-seeded:${def.id}`;
    if (!store.get(seeded)) {
      for (const scope of def.grants ?? []) core.addGrant(def.id, scope, OWNER);
      store.set(seeded, "1");
    }
    await core
      .addAgent({ id: def.id, name: def.name, workspace: ws }, runtimeFor(def), {
        agentId: def.id,
        name: def.name ?? def.id.slice(6),
        workspaceDir: dir,
        stateDir: agentState,
        mcp: { url: `${url}/mcp/${def.id}`, headers: { "x-ash-token": tokens.mcp[def.id] } },
        log: (...a) => log(`[${def.id}]`, ...a),
      })
      .then(() => log(`${def.id} ready (${def.runtime})`))
      .catch((e) => log(`${def.id} failed to start:`, e instanceof Error ? e.stack : e));
  }
  core.startTimers();

  // Gateway (optional): configured in the file or later from the UI.
  let link: OwnerLink | null = null;
  let signer: Signer | null = null;
  const gwFile = join(cfg.stateDir, "gateway.json");
  const secretFile = join(cfg.stateDir, "bootstrap-secret");
  const startLink = async (gatewayUrl: string) => {
    link?.stop();
    signer ??= bridge ? await bridge.signer() : await fileSigner(cfg.stateDir);
    const l = new OwnerLink(gatewayUrl, signer, core, router, log, (p) => {
      void core.notify({ title: "新设备请求配对", text: `${p.name}（指纹 ${p.fingerprint}）— 在 ash 的「设备」里确认`, urgency: "high" }, "service:ash");
    });
    link = l;
    void (async () => {
      await l.claimIfNeeded(secretFile, cfg.name ?? "ash phone");
      if (link === l) await l.run();
    })();
  };
  const gatewayUrl = existsSync(gwFile) ? (JSON.parse(readFileSync(gwFile, "utf8")).url as string) : cfg.gateway?.url;
  if (gatewayUrl) await startLink(gatewayUrl);
  ext.gateway = {
    state: async () => (link ? link.state() : { configured: false }),
    op: async (op, b) => {
      if (op === "configure") {
        const u = new URL(String(b.url ?? ""));
        if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("the gateway URL must be https");
        writeFileSync(gwFile, JSON.stringify({ url: u.origin }), { mode: 0o600 });
        if (typeof b.secret === "string" && b.secret.trim()) writeFileSync(secretFile, b.secret.trim(), { mode: 0o600 });
        await startLink(u.origin);
        return { ok: true };
      }
      if (!link) throw new Error("no gateway configured");
      const l: OwnerLink = link;
      switch (op) {
        case "ticket":
          return l.ticket();
        case "approve":
          await l.approve(String(b.request_id), (b.permissions as never) ?? ["chat", "web_ui"]);
          return { ok: true };
        case "reject":
          await l.reject(String(b.request_id));
          return { ok: true };
        case "revoke":
          await l.revoke(String(b.device));
          return { ok: true };
        case "sync":
          await l.syncDevices();
          return l.state();
      }
      throw new Error(`unknown gateway op ${op}`);
    },
  };

  return {
    core,
    url,
    tokens,
    close: async () => {
      link?.stop();
      bridge?.stop();
      await core.stop();
      await dsh?.stop().catch(() => {});
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

// ------------------------------------------------------------------ client

export async function startClient(cfg: Config, pairCode?: string): Promise<{ close: () => void }> {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  if (!cfg.gateway?.url) throw new Error("client role needs gateway.url");
  const signer = await fileSigner(cfg.stateDir);
  const mcp = new McpCapabilities(cfg.mcp ?? {}, log);
  const name = cfg.name ?? hostname();
  const link = new ClientLink(
    cfg.gateway.url,
    signer,
    {
      manifest: async () => ({ name, kind: "laptop", capabilities: await mcp.capabilities() }),
      call: (capability, args) => mcp.call(capability, args),
    },
    log,
  );
  await link.pair(cfg.stateDir, pairCode, name);
  void link.run();
  return {
    close: () => {
      link.stop();
      mcp.close();
    },
  };
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && /ash-core|main\.[tj]s$/.test(process.argv[1])) {
  const arg = (f: string) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : undefined);
  const file = arg("--config");
  if (!file) {
    console.error("usage: ash-core --config <file> [--pair <code>]");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Config;
  const run = cfg.role === "client" ? startClient(cfg, arg("--pair")) : startOwner(cfg);
  run.catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}

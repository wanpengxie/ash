/**
 * A kernel for the computer program to talk to: the link server and the hand registry (T5) with the bodies service (T18)
 * on a database of its own, and a stand-in for the agents module that drives the computer's runtimes over the agent
 * channel. The tunnel to the computer is the relay's: a `DeviceStream` over an in-memory socket, handed to the program's
 * `TunnelPort` while the kernel `accept`s the other end the way it accepts a relay tunnel.
 */
import { delimiter, join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { DeviceStream } from "ash-gateway/client/client";
import type { AgentFrame } from "../../sdk/src/link";
import { WordError, type HandleContext, type Message, type WordResult } from "../../sdk/src/message";
import type { Member } from "../../sdk/src/word";
import type { LinkSession } from "../../link/src/server";
import { memoryPair } from "../../link/test/fixtures/memory";
import { createLinkServer, type HubLinkServer } from "../../core/src/edges/link-server";
import { createBodies, splitBodyCapabilities, type Bodies } from "../../core/src/edges/link-server/hands/bodies";
import { HandRegistry } from "../../core/src/edges/link-server/hands/registry";
import { FakeRegistry, FakeRouter } from "../../core/test/edges/link-server/harness";
import { eventually } from "../../core/test/fixtures/wait";
import type { RunningDevice } from "../src/main";

export { eventually };

let counter = 0;
export const request = (to: string, word: string, body: unknown = {}, from = "agent:main"): Message =>
  ({ seq: ++counter, id: `m${counter}`, ts: 0, from, to, kind: "request", word, body });
export const context = (over: Partial<HandleContext> = {}): HandleContext =>
  ({ signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false, turn: "t1" }, raw: undefined, ...over });
export const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return error instanceof WordError ? error.code : `not a WordError: ${String(error)}`; }
  return "none";
};

/** The stand-in for the agents module's remote driver: calls driver operations, collects events, answers tool calls. */
export class RemoteDrivers {
  session: LinkSession | null = null;
  readonly events: Record<string, any>[] = [];
  readonly tools: Record<string, any>[] = [];
  private readonly waiting = new Map<string, (frame: Record<string, any>) => void>();
  private n = 0;
  /** How a tool call is answered (default: ok with an empty agent list). */
  answer: (frame: Record<string, any>) => Record<string, unknown> = () => ({ ok: true, result: { agents: [] } });

  attach(session: LinkSession) {
    this.session = session;
    return { agent: (frame: AgentFrame) => this.receive(frame as Record<string, any>), closed: () => { if (this.session === session) this.session = null; } };
  }
  private receive(frame: Record<string, any>): void {
    if (typeof frame.op_result === "string") this.waiting.get(frame.id)?.(frame);
    else if (typeof frame.outbound === "string") {
      this.tools.push(frame);
      this.session?.send({ t: "agent", id: frame.id, outbound_result: frame.outbound, ...this.answer(frame) } as AgentFrame);
    } else if (typeof frame.event === "string") this.events.push(frame);
  }
  /** One operation; resolves with the whole `op_result` frame. */
  call(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const session = this.session;
    if (!session) throw new Error("the agent channel is not open");
    const id = `a${++this.n}`;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      session.send({ t: "agent", id, op, ...fields } as AgentFrame);
    });
  }
  /** The result of an operation that must succeed. */
  async ok(op: string, fields: Record<string, unknown> = {}): Promise<any> {
    const reply = await this.call(op, fields);
    if (reply.ok !== true) throw new Error(`${op} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }
  named(event: string, filter: (e: Record<string, any>) => boolean = () => true): Record<string, any>[] { return this.events.filter((e) => e.event === event && filter(e)); }
  async waitFor(event: string, filter: (e: Record<string, any>) => boolean = () => true, what = event): Promise<Record<string, any>> {
    return eventually(() => this.named(event, filter)[0], `the ${what} event`);
  }
}

export interface Kernel {
  db: DatabaseSync;
  registry: FakeRegistry;
  router: FakeRouter;
  hands: HandRegistry;
  bodies: Bodies;
  server: HubLinkServer;
  remote: RemoteDrivers;
  stop(): Promise<void>;
  /** The owner pairs a computer (what `pair_approve` writes) with the permissions that are ticked. */
  pair(device: { id: string; publicKey: string }, permissions?: { lend?: boolean; local_agents?: boolean; web_ui?: boolean; name?: string }): void;
  /** Calls a word of a registered member as `agent:main` would after the router let it through. */
  call(to: string, word: string, body?: Record<string, unknown>): Promise<WordResult>;
  /** `service:bodies` words. */
  body(word: string, body: Record<string, unknown>): Promise<any>;
}

export async function startKernel(): Promise<Kernel> {
  const db = new DatabaseSync(":memory:");
  const registry = new FakeRegistry();
  const router = new FakeRouter();
  const remote = new RemoteDrivers();
  const hub: { hands?: HandRegistry } = {};
  const call = async (to: string, word: string, body: Record<string, unknown> = {}): Promise<WordResult> => {
    const member = registry.members.get(to) as Member | undefined;
    if (!member) throw new WordError("offline", `${to} is not registered`);
    return (await member.handle(request(to, word, body), context({ raw: body }))) ?? {};
  };
  const bodies = createBodies({
    db, hands: { get: (id) => hub.hands!.view(id) }, rebind: (hand) => hub.hands!.rebind(hand),
    call: (to, word, body) => call(to, word, (body ?? {}) as Record<string, unknown>),
  });
  const hands = hub.hands = new HandRegistry({ db, registry, router, bodies, splitBodyCapabilities });
  const server = createLinkServer({ hands, hostClient: { handsHandoff: async () => ({ supported: false }) } });
  server.onChannel("agent", (session) => remote.attach(session));
  await server.start();
  return {
    db, registry, router, hands, bodies, server, remote,
    stop: () => server.stop(),
    pair: (device, permissions = {}) => void hands.register({
      id: device.id, name: permissions.name ?? "Test Mac", kind: "computer", public_key: device.publicKey, paired_by: "gateway",
      lend: permissions.lend ?? true, local_agents: permissions.local_agents ?? true, web_ui: permissions.web_ui ?? false,
    }),
    call,
    body: async (word, body) => ((await bodies.handle(request("service:bodies", word, body, "person:owner"), context({ caller: { member: "person:owner", via: "human", local: true } }))) as WordResult).data,
  };
}

let tunnels = 0;
/**
 * The relay opens a tunnel for the hub: the kernel accepts one end as it does a relay tunnel for device [from], and the
 * other end is a `DeviceStream` handed to the program. Returns a way to cut the tunnel from the relay's side.
 */
export function openTunnel(kernel: Pick<Kernel, "server">, device: Pick<RunningDevice, "port">, from: string, peer = "kernel"): { cut(code?: number, reason?: string): void } {
  const pair = memoryPair();
  const sid = `o-test-tunnel-${++tunnels}-xxxxxxxxxxxxxxxx`;
  let parts: string[] = [];
  const stream = new DeviceStream(sid, peer, "/link", (frame) => {
    if (frame.op === "ws.msg") {
      parts.push(String(frame.text));
      if (frame.more !== true) { const text = parts.join(""); parts = []; pair.hand.send(text); }
    } else if (frame.op === "ws.close") pair.hand.close(Number(frame.code), String(frame.reason));
  }, () => {});
  pair.hand.on("message", (data: string) => stream.accept({ op: "ws.msg", text: data, more: false, from: peer }));
  pair.hand.on("close", (code: number, reason: Buffer) => stream.finish({ code, reason: reason.toString() }));
  kernel.server.acceptGateway(pair.server, from);
  device.port.adopt(stream);
  return { cut: (code = 1006, reason = "tunnel lost") => pair.server.close(code, reason) };
}

/**
 * A `codex` that is a script: it runs the fixture instead (put the returned directory in front of `PATH`).
 * `login status` answers at once, as the real one does.
 */
export async function fakeCodex(dir: string, fixture: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const file = join(bin, "codex");
  await writeFile(file, `#!/bin/sh\nif [ "$1" = login ]; then exit 0; fi\nexec "${process.execPath}" "${fixture}" codex\n`);
  await chmod(file, 0o755);
  return bin;
}
export const withPath = (dir: string): string => `${dir}${delimiter}${process.env.PATH ?? ""}`;

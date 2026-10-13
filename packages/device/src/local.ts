/**
 * The door of the running ash-device for other programs of the same user on this computer: a unix socket in the state
 * directory (mode 0600, in a 0700 directory). `ash-device mcp` (the MCP server the Codex App starts) comes in here and the
 * call goes to the hub over the connection this program already holds.
 *
 * One JSON line in: `{id, tool, args?, session?}`; one JSON line out: `{id, ok: true, result}` or `{id, ok: false, error: {message}}`.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";

const MAX_LINE = 4 * 1024 * 1024;

export type LocalCall = (tool: string, args: unknown, session: string | undefined) => Promise<unknown>;

export async function serveLocal(path: string, call: LocalCall, log: (message: string, error?: unknown) => void = () => {}): Promise<{ close(): void }> {
  // A socket file that nobody listens on is what a crash leaves; one that answers belongs to another ash-device: leave it.
  if (existsSync(path)) {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = createConnection(path);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (alive) throw new Error("another ash-device is already serving this directory");
    unlinkSync(path);
  }
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    const reply = (body: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(body) + "\n"); };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { socket.destroy(); return; }
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let frame: { id?: unknown; tool?: unknown; args?: unknown; session?: unknown };
        try { frame = JSON.parse(line); } catch { reply({ ok: false, error: { message: "not JSON" } }); continue; }
        const id = frame.id;
        if (typeof frame.tool !== "string" || !frame.tool) { reply({ id, ok: false, error: { message: "tool is required" } }); continue; }
        call(frame.tool, frame.args, typeof frame.session === "string" ? frame.session : undefined)
          .then((result) => reply({ id, ok: true, result }), (error) => reply({ id, ok: false, error: { message: String((error as Error)?.message ?? error).slice(0, 500) } }));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
  try { chmodSync(path, 0o600); } catch (error) { log("could not restrict the local socket", error); }
  return { close() { server.close(); try { unlinkSync(path); } catch { /* already gone */ } } };
}

/** One call to the running ash-device; rejects with a message that says what is wrong when it is not there. */
export function callLocal(path: string, tool: string, args: unknown, session: string | undefined, timeoutMs = 130_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "", done = false;
    const end = (error?: Error, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => end(new Error("ash-device did not answer in time")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id: 1, tool, args, ...(session ? { session } : {}) }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      try {
        const body = JSON.parse(buffer.slice(0, at));
        body.ok === true ? end(undefined, body.result) : end(new Error(String(body.error?.message ?? "the call failed")));
      } catch { end(new Error("ash-device answered with something that is not JSON")); }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => end(new Error(
      error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? "ash-device is not running on this computer. Start its service (macOS: launchctl kickstart gui/$UID/ai.ash.device; Linux: systemctl --user start ash-device) or run `ash-device run`."
        : `could not reach ash-device: ${error.message}`)));
    socket.once("close", () => end(new Error("ash-device closed the connection before answering")));
  });
}

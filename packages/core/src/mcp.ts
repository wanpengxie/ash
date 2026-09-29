// MCP projection: ash system services and the agent's granted device capabilities as one
// Streamable-HTTP MCP server per agent (JSON responses, no server-initiated streams). This is
// how out-of-process runtimes (Codex, Claude Code, …) reach ash; DSH uses the in-process door.

import type { Core } from "./core";
import { SYSTEM_TOOL_DEFS, runSystemTool } from "./tools";

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const PROTOCOL = "2025-06-18";

/** Device tools are named `<device slug>__<capability>` (slug from the device name, ASCII). */
export function deviceToolName(deviceName: string, deviceId: string, capability: string): string {
  const slug = (deviceName.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || deviceId.replace(/^device:/, "").slice(0, 8)).slice(0, 20);
  return `${slug}__${capability.replace(/[^A-Za-z0-9_-]+/g, "_")}`.slice(0, 64);
}

export async function handleMcp(core: Core, agent: string, body: unknown): Promise<[number, unknown]> {
  const port = core.portOf(agent);
  const one = async (m: Rpc): Promise<unknown | null> => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
    if (m.id === undefined || m.id === null) return null; // notification
    switch (m.method) {
      case "initialize":
        return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ash", version: "1" }, instructions: port.contextSections().identity });
      case "ping":
        return reply({});
      case "tools/list": {
        const tools = SYSTEM_TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
        for (const { device, capability } of port.projectedCapabilities()) {
          tools.push({ name: deviceToolName(device.name, device.id, capability.name), description: `[${device.name}] ${capability.description}`, inputSchema: capability.input_schema as never });
        }
        return reply({ tools });
      }
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments as Record<string, unknown>) ?? {};
        const proj = port.projectedCapabilities().find(({ device, capability }) => deviceToolName(device.name, device.id, capability.name) === name);
        const r = proj ? await port.call(proj.device.id, proj.capability.name, args) : await runSystemTool(port, name, args);
        return reply({ content: r.content, isError: !r.ok, ...(r.data !== undefined && typeof r.data === "object" && !Array.isArray(r.data) ? { structuredContent: r.data } : {}) });
      }
      default:
        return error(-32601, `method not found: ${m.method}`);
    }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(m as Rpc)))).filter((x) => x !== null);
    return out.length ? [200, out] : [202, null];
  }
  const r = await one(body as Rpc);
  return r === null ? [202, null] : [200, r];
}

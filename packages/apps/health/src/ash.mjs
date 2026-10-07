// The way back into Ash: the MCP endpoint Ash gave this app (ASH_MCP_URL, ASH_MCP_TOKEN). Only what the owner
// granted at install can be called; events go through ash_event.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function ashClient(url, token) {
  let client = null;
  const connect = async () => {
    if (client) return client;
    if (!url || !token) throw new Error("not started by Ash (ASH_MCP_URL / ASH_MCP_TOKEN missing)");
    const next = new Client({ name: "health", version: "1.0.0" });
    await next.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    client = next;
    return next;
  };
  const tool = async (name, args) => {
    try {
      const result = await (await connect()).callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const out = result.structuredContent ?? JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "{}");
      if (!out.ok) throw Object.assign(new Error(`${out.error?.code ?? "failed"}: ${out.error?.message ?? ""}`), { code: out.error?.code });
      return out.result;
    } catch (error) {
      if (!error.code) { try { await client?.close(); } catch { /* gone */ } client = null; }
      throw error;
    }
  };
  return {
    call: (member, word, body) => tool("capability_call", { member, word, body }),
    event: (name, body) => tool("ash_event", { name, body }),
  };
}

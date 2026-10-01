// Retired ash-api/1 client, retained only for isolated legacy contract tests.

import {
  type AgentInfo,
  AshApiError,
  type AshEvent,
  type CallRequest,
  type CallResult,
  type Confirmation,
  type DeliverRequest,
  type DeliverResult,
  type DeviceInfo,
  type Grant,
  type Identity,
  type Member,
  type NotifyRequest,
  type Timer,
  type TimerRequest,
} from "../../../sdk/src/api";

export interface Manifest {
  api: string;
  space: string;
  me: string;
  owner: string;
  members: Member[];
  agents: AgentInfo[];
  devices: DeviceInfo[];
  caller: { member: string; local: boolean; owner: boolean; manage: boolean };
}

export class AshClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  manifest(): Promise<Manifest> {
    return this.call("GET", "/api/manifest");
  }
  me(): Promise<Identity> {
    return this.call("GET", "/api/me");
  }
  members(): Promise<Member[]> {
    return this.call("GET", "/api/members");
  }
  agents(): Promise<AgentInfo[]> {
    return this.call("GET", "/api/agents");
  }
  deliver(agent: string, req: DeliverRequest): Promise<DeliverResult> {
    return this.call("POST", `/api/agents/${encodeURIComponent(agent)}/deliver`, req);
  }
  cancel(agent: string): Promise<{ cancelled: boolean }> {
    return this.call("POST", `/api/agents/${encodeURIComponent(agent)}/cancel`, {});
  }
  inbox(agent: string): Promise<{ running: unknown; queued: unknown[] }> {
    return this.call("GET", `/api/agents/${encodeURIComponent(agent)}/inbox`);
  }
  events(q: { after?: number; limit?: number; workspace?: string; type?: string } = {}): Promise<{ events: AshEvent[]; next: number }> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.call("GET", `/api/events?${p}`);
  }
  devices(): Promise<DeviceInfo[]> {
    return this.call("GET", "/api/devices");
  }
  callDevice(req: CallRequest): Promise<CallResult> {
    return this.call("POST", "/api/call", req);
  }
  timers(): Promise<Timer[]> {
    return this.call("GET", "/api/timers");
  }
  setTimer(req: TimerRequest): Promise<Timer> {
    return this.call("POST", "/api/timers", req);
  }
  cancelTimer(id: string): Promise<{ cancelled: boolean }> {
    return this.call("DELETE", `/api/timers/${encodeURIComponent(id)}`);
  }
  notify(req: NotifyRequest): Promise<{ ok: true }> {
    return this.call("POST", "/api/notify", req);
  }
  confirms(): Promise<Confirmation[]> {
    return this.call("GET", "/api/confirms");
  }
  answer(id: string, approve: boolean): Promise<{ answered: boolean }> {
    return this.call("POST", `/api/confirms/${encodeURIComponent(id)}`, { approve });
  }
  grants(member?: string): Promise<Grant[]> {
    return this.call("GET", `/api/grants${member ? `?member=${encodeURIComponent(member)}` : ""}`);
  }
  grant(member: string, scope: string): Promise<Grant> {
    return this.call("POST", "/api/grants", { member, scope });
  }
  revokeGrant(id: string): Promise<{ revoked: boolean }> {
    return this.call("DELETE", `/api/grants/${encodeURIComponent(id)}`);
  }
  settings(): Promise<Record<string, unknown>> {
    return this.call("GET", "/api/settings");
  }
  setSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("POST", "/api/settings", body);
  }
  gateway(): Promise<Record<string, unknown>> {
    return this.call("GET", "/api/gateway");
  }
  gatewayOp(op: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.call("POST", `/api/gateway/${op}`, body);
  }

  /** Follow the event log (Server-Sent Events), reconnecting with the last seen seq. */
  async *stream(after = 0, signal?: AbortSignal): AsyncGenerator<AshEvent> {
    let cursor = after;
    while (!signal?.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/api/events/stream?after=${cursor}`, { headers: { authorization: `Bearer ${this.token}` }, signal });
        if (!res.ok || !res.body) throw new AshApiError(res.status, "stream_failed", await res.text());
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (!data) continue;
            const e = JSON.parse(data.slice(6)) as AshEvent;
            cursor = e.seq;
            yield e;
          }
        }
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof AshApiError && e.status === 401) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new AshApiError(res.status, String(data.error ?? "http_error"), String(data.message ?? text.slice(0, 200)));
    return data as T;
  }
}

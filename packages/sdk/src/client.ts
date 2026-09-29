// Zero-dependency client for `ash-api/1` (Node >= 22 and browsers).

import {
  type AgentInfo,
  AshApiError,
  type AshEvent,
  type DeliverRequest,
  type DeliverResult,
  type Member,
  type NotifyRequest,
  type Timer,
  type TimerRequest,
} from "./api";

export interface Manifest {
  api: string;
  space: string;
  me: string;
  members: Member[];
  agents: AgentInfo[];
}

export class AshClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  manifest(): Promise<Manifest> {
    return this.call("GET", "/v1/manifest");
  }
  members(): Promise<Member[]> {
    return this.call("GET", "/v1/members");
  }
  agents(): Promise<AgentInfo[]> {
    return this.call("GET", "/v1/agents");
  }
  deliver(agent: string, req: DeliverRequest): Promise<DeliverResult> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/deliver`, req);
  }
  cancel(agent: string): Promise<{ cancelled: boolean }> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/cancel`, {});
  }
  events(q: { after?: number; limit?: number; workspace?: string; type?: string } = {}): Promise<{ events: AshEvent[]; next: number }> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.call("GET", `/v1/events?${p}`);
  }
  timers(): Promise<Timer[]> {
    return this.call("GET", "/v1/timers");
  }
  setTimer(req: TimerRequest): Promise<Timer> {
    return this.call("POST", "/v1/timers", req);
  }
  cancelTimer(id: string): Promise<{ cancelled: boolean }> {
    return this.call("DELETE", `/v1/timers/${encodeURIComponent(id)}`);
  }
  notify(req: NotifyRequest): Promise<{ ok: true }> {
    return this.call("POST", "/v1/notify", req);
  }

  /**
   * Follow the event log from `after` (Server-Sent Events). Returns a stop function.
   * Reconnects with the last seen seq, so no event is skipped or repeated.
   */
  stream(onEvent: (e: AshEvent) => void, opts: { after?: number; onError?: (e: unknown) => void } = {}): () => void {
    let after = opts.after ?? 0;
    let stopped = false;
    let ctrl: AbortController | null = null;
    const loop = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`${this.baseUrl}/v1/events/stream?after=${after}`, {
            headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new AshApiError(res.status, "stream", await res.text());
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n");
              if (!data) continue;
              const e = JSON.parse(data) as AshEvent;
              after = Math.max(after, e.seq);
              onEvent(e);
            }
          }
        } catch (e) {
          if (stopped) return;
          opts.onError?.(e);
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void loop();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
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
      // non-JSON
    }
    if (!res.ok) throw new AshApiError(res.status, String(data.error ?? "http_error"), String(data.message ?? text.slice(0, 200)));
    return data as T;
  }
}

export * from "./api";

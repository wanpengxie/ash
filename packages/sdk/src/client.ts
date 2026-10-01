// Public ash-api/2 edge client. The retired ash-api/1 client is test-only.
import {
  AshApiError, AUTH_SCOPE_EVENT, MESSAGE_SUMMARY_EVENT, POST_DELIVERY_SNAPSHOT_EVENT,
  SCREEN_REGISTRATION_EVENT, SCREEN_TOKEN_HEADER, STREAM_ERROR_EVENT, STREAM_PAGE_END_EVENT,
  isAuthScopeControlV2, isMessageSummaryV2, isScreenRegistration, isStreamErrorV2, isStreamPageEndV2,
  type DescribeDetail, type DescribeSummary, type Message, type MessageSummaryV2,
  type PostDeliverySnapshotV2, type ScreenRegistration, type SendRequestV2, type SendResultV2,
  type StreamPageEndV2,
} from "./api";
import { postDeliverySnapshotErrors } from "./words";

export type StreamFrameV2 =
  | { type: "scope"; scope: string }
  | { type: "screen"; registration: ScreenRegistration }
  | { type: "snapshot"; snapshot: PostDeliverySnapshotV2 }
  | { type: "page_end"; page: StreamPageEndV2 }
  | { type: "message"; message: Message | MessageSummaryV2 };

export interface ClientStreamOptions {
  after?: number;
  before?: number;
  limit?: number;
  follow?: boolean;
  summary?: boolean;
  screen?: string;
  label?: string;
  /** Expected scope from a previously persisted cursor; mismatches fail before any row. */
  authScope?: string;
  signal?: AbortSignal;
}

interface ClientOptions { retryMs?: number; fetchImpl?: typeof fetch }
interface ParsedEvent { event: string; id: string; data: string }
const validSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const rawMessage = (value: unknown): value is Message => object(value) && validSeq(value.seq) && typeof value.id === "string" && !!value.id &&
  Number.isSafeInteger(value.ts) && typeof value.from === "string" && !!value.from && (value.to === null || typeof value.to === "string") &&
  ["request", "response", "event"].includes(String(value.kind)) && typeof value.word === "string" && !!value.word && object(value.body) &&
  (value.reply_to === undefined || typeof value.reply_to === "string") && (value.turn === undefined || typeof value.turn === "string");
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

function parseEvent(block: string): ParsedEvent {
  let event = "message";
  let id = "";
  const data: string[] = [];
  for (const line of block.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = (colon < 0 ? "" : line.slice(colon + 1)).replace(/^ /, "");
    if (name === "event") event = value;
    else if (name === "id") id = value;
    else if (name === "data") data.push(value);
  }
  return { event, id, data: data.join("\n") };
}

/** SSE block parser preserves fragmented UTF-8 and discards incomplete frames on disconnect. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let pendingBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      let completed = false;
      while ((boundary = /\r?\n\r?\n|\r\r/.exec(pending))) {
        completed = true;
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (encoder.encode(block).byteLength > MAX_FRAME_BYTES) throw new AshApiError(413, "too_large", "stream frame too large");
        if (block) yield parseEvent(block);
      }
      pendingBytes = completed ? encoder.encode(pending).byteLength : pendingBytes + value.byteLength;
      if (pendingBytes > MAX_FRAME_BYTES) throw new AshApiError(413, "too_large", "stream frame too large");
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function httpError(status: number, raw: string): AshApiError {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = null; }
  return new AshApiError(status, object(data) && typeof data.error === "string" ? data.error : "http_error",
    object(data) && typeof data.message === "string" ? data.message : raw.slice(0, 200));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class AshClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly retryMs: number;
  readonly fetchImpl: typeof fetch;
  lastSeq = 0;
  authScope: string | null = null;
  screen: ScreenRegistration | null = null;

  constructor(baseUrl: string, token?: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.retryMs = Number.isSafeInteger(options.retryMs) && options.retryMs! >= 0 ? options.retryMs! : 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async describe(member?: string, signal?: AbortSignal): Promise<DescribeSummary | DescribeDetail> {
    const path = `/api/describe${member === undefined ? "" : `?member=${encodeURIComponent(member)}`}`;
    const response = await this.fetchImpl(this.baseUrl + path, { headers: this.headers(), credentials: "same-origin", signal });
    if (!response.ok) throw httpError(response.status, await response.text());
    return response.json() as Promise<DescribeSummary | DescribeDetail>;
  }

  /** Keep client_id unchanged when replaying an uncertain HTTP acknowledgement. */
  async send(request: SendRequestV2, options: { signal?: AbortSignal; screenToken?: string } = {}): Promise<SendResultV2> {
    const screenToken = options.screenToken ?? this.screen?.token;
    const response = await this.fetchImpl(`${this.baseUrl}/api/send`, { method: "POST", credentials: "same-origin", signal: options.signal,
      headers: this.headers({ "content-type": "application/json", ...(screenToken ? { [SCREEN_TOKEN_HEADER]: screenToken } : {}) }), body: JSON.stringify(request) });
    if (!response.ok) throw httpError(response.status, await response.text());
    return response.json() as Promise<SendResultV2>;
  }

  /** Yield control frames separately: only numbered messages advance the resume cursor. */
  async *stream(options: ClientStreamOptions = {}): AsyncGenerator<StreamFrameV2> {
    const { signal, follow = true } = options;
    if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0)) throw new TypeError("invalid after cursor");
    if (options.before !== undefined && (!validSeq(options.before) || follow || options.after !== undefined)) throw new TypeError("invalid before cursor");
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)) throw new TypeError("invalid stream limit");
    let cursor = options.after ?? 0;
    let expectedScope = options.authScope ?? this.authScope;
    let first = true;
    this.lastSeq = cursor;
    while (!signal?.aborted) {
      const params = new URLSearchParams();
      // A disconnected brand-new stream has no Last-Event-ID yet. Explicit
      // after=0 replays the whole gap; an omitted cursor would show only the
      // latest window and could silently lose more than `limit` messages.
      if (first && options.after !== undefined) params.set("after", String(options.after));
      else if (!first && cursor === 0) params.set("after", "0");
      if (first && options.before !== undefined) params.set("before", String(options.before));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (!follow) params.set("follow", "false");
      if (options.summary) params.set("summary", "true");
      if (options.screen) params.set("screen", options.screen);
      if (options.label) params.set("label", options.label);
      const path = `/api/stream${params.size ? `?${params}` : ""}`;
      const resumeHeader: Record<string, string> = !first && cursor ? { "Last-Event-ID": String(cursor) } : {};
      const resumeFloor = cursor;
      first = false;
      try {
        const response = await this.fetchImpl(this.baseUrl + path, { headers: this.headers(resumeHeader), credentials: "same-origin", signal });
        if (!response.ok) throw httpError(response.status, await response.text());
        if (!response.body) throw new AshApiError(502, "stream_failed", "missing stream body");
        let scoped = false;
        for await (const frame of events(response.body)) {
          if (!frame.data) continue;
          let data: unknown;
          try { data = JSON.parse(frame.data); } catch { throw new AshApiError(502, "bad_stream", "invalid SSE JSON"); }
          if (frame.event === AUTH_SCOPE_EVENT || frame.event === SCREEN_REGISTRATION_EVENT) {
            if (frame.id) throw new AshApiError(502, "bad_stream", "control frame has cursor");
            const scope = frame.event === AUTH_SCOPE_EVENT && isAuthScopeControlV2(data) ? data.auth_scope :
              frame.event === SCREEN_REGISTRATION_EVENT && isScreenRegistration(data) ? data.auth_scope : null;
            if (!scope || scoped) throw new AshApiError(502, "bad_stream", "invalid or duplicate auth scope");
            if (expectedScope && expectedScope !== scope) {
              this.screen = null;
              throw new AshApiError(409, "auth_scope_changed", "stream identity changed");
            }
            expectedScope = this.authScope = scope;
            scoped = true;
            if (frame.event === SCREEN_REGISTRATION_EVENT) { this.screen = data as ScreenRegistration; yield { type: "screen", registration: data as ScreenRegistration }; }
            else yield { type: "scope", scope };
            continue;
          }
          if (!scoped) throw new AshApiError(502, "bad_stream", "missing authenticated scope");
          if (frame.event === STREAM_ERROR_EVENT) {
            if (frame.id || !isStreamErrorV2(data)) throw new AshApiError(502, "bad_stream", "invalid stream error frame");
            throw new AshApiError(data.code === "too_large" ? 413 : 502, data.code, "server stream failed");
          }
          if (frame.event === STREAM_PAGE_END_EVENT) {
            if (frame.id || !isStreamPageEndV2(data)) throw new AshApiError(502, "bad_stream", "invalid page boundary");
            yield { type: "page_end", page: data };
            continue;
          }
          if (frame.event === POST_DELIVERY_SNAPSHOT_EVENT) {
            if (frame.id || postDeliverySnapshotErrors(data).length) throw new AshApiError(502, "bad_stream", "invalid delivery snapshot");
            yield { type: "snapshot", snapshot: data as PostDeliverySnapshotV2 };
            continue;
          }
          if (frame.event !== "message" && frame.event !== MESSAGE_SUMMARY_EVENT) throw new AshApiError(502, "bad_stream", "unknown stream event");
          if (!/^[1-9][0-9]*$/.test(frame.id) || !validSeq(Number(frame.id)) || !object(data) || data.seq !== Number(frame.id) ||
            (frame.event === MESSAGE_SUMMARY_EVENT ? !isMessageSummaryV2(data) : !rawMessage(data)))
            throw new AshApiError(502, "bad_stream", "invalid numbered message");
          const seq = Number(frame.id);
          if (seq <= resumeFloor) continue; // server replay after reconnect is harmless
          if (seq <= cursor) throw new AshApiError(502, "bad_stream", "stream sequence moved backwards");
          cursor = this.lastSeq = seq;
          yield { type: "message", message: data as unknown as Message | MessageSummaryV2 };
        }
        if (!follow) return;
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof AshApiError && (error.status === 401 || error.status === 403)) this.screen = null;
        if (!follow) throw error;
        if (error instanceof AshApiError && (error.status < 500 || error.code === "bad_stream")) throw error;
      }
      await delay(this.retryMs, signal);
    }
  }
}

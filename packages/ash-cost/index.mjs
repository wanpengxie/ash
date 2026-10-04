// ash-cost: the collecting half of ash's cost centre, living in the DSH world.
//
// Every model call DSH makes — the conversation, the private mind session, titles, compaction, and ash's own
// background judgements through the shared llm service — passes through the `llm/stream` waterfall. This plugin
// watches that one place and reports what each call used. It never alters a stream, and it never holds a secret
// outside this process: the API key is resolved through DSH's own credential service only to ask the provider for
// the account balance, and only the balance leaves.
//
// The ash world decides what a call is worth and how it is shown; it reads this plugin through `collector`.

export const name = "ash-cost";
export const inject = ["llm"];

const MAX_ERROR = 200;

function createCollector() {
  const listeners = new Set();
  const scopes = new Map(); // DSH session id -> what ash uses that session for
  let ctx = null;

  /** Which part of ash a call belongs to, from facts DSH puts on the request. */
  function scopeOf(options) {
    if (options.purpose === "session-title") return "title";
    if (options.purpose === "compaction") return "compaction";
    if (typeof options.sessionId === "string") return scopes.get(options.sessionId) ?? "other";
    // No session: ash's own tool-free judgements (memory, proactive, opener, reflex…).
    return "background";
  }

  function normalize(usage) {
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return { input: count(usage?.inputTokens), output: count(usage?.outputTokens),
      cacheRead: count(usage?.cacheReadTokens), cacheWrite: count(usage?.cacheWriteTokens) };
  }

  function publish(record) {
    for (const listener of [...listeners]) {
      try { listener(record); } catch { /* a reporting failure must never reach the model call */ }
    }
  }

  async function* tap(options, stream) {
    const started = Date.now();
    let usage = null;
    let failure = null;
    try {
      for await (const chunk of stream) {
        if (chunk?.type === "usage" && chunk.usage) usage = chunk.usage;
        yield chunk;
      }
    } catch (error) {
      failure = String(error?.code ?? error?.name ?? "error").slice(0, MAX_ERROR);
      throw error;
    } finally {
      // A call cut off before the provider reported usage spent nothing we can state; say nothing rather than guess.
      if (usage) publish({ at: started, ms: Date.now() - started, scope: scopeOf(options),
        provider: String(options.provider ?? ""), model: String(options.model ?? ""), ...normalize(usage), ok: failure === null });
    }
  }

  return {
    /** Called by the ash host after it starts a session, so the session's calls are named by what ash uses it for. */
    label(sessionId, scope) { scopes.set(sessionId, scope); },
    onUsage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    tap,
    attach(context) { ctx = context; },
    /**
     * The account balance the provider reports for the configured API key. The key is resolved inside DSH and never
     * returned. Throws with a short reason when it cannot be read; a failure is never a zero balance.
     */
    async balance(options = {}) {
      if (!ctx) throw new Error("cost collector is not attached");
      const ref = String(options.credential ?? "DEEPSEEK_API_KEY");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("invalid credential name");
      let key;
      try { key = (await ctx.get("credentials")?.resolve(ref))?.value; } catch { key = undefined; }
      // The same fallback DSH's own provider uses: the environment the process was launched with.
      if (typeof key !== "string" || !key) key = process.env[ref];
      if (typeof key !== "string" || !key) throw new Error("no API key is configured");
      const origin = new URL(options.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").origin;
      const response = await fetch(`${origin}/user/balance`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
      if (!response.ok) throw new Error(`the provider answered HTTP ${response.status}`);
      const body = await response.json();
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
      return { available: body?.is_available === true, balances: infos.map((info) => ({
        currency: String(info.currency ?? ""), total: String(info.total_balance ?? ""),
        granted: String(info.granted_balance ?? ""), topped_up: String(info.topped_up_balance ?? "") })) };
    },
  };
}

export const collector = createCollector();

export function apply(ctx) {
  collector.attach(ctx);
  ctx.on("llm/stream", (options, next) => collector.tap(options, next()), { global: true });
}

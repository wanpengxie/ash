/**
 * Waits for an outcome, never for a fixed time: [probe] is polled until it gives a value (not null, undefined or false).
 * The bound only stops a stuck test; it is far above any real outcome, so a loaded machine (a slow disk, a busy CPU)
 * makes a test slower but never makes it fail, and nothing that is asserted changes.
 */
export async function eventually<T>(probe: () => T | Promise<T>, what: string, ms = 60_000, every = 5): Promise<Exclude<T, null | undefined | false>> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value as Exclude<T, null | undefined | false>;
    if (Date.now() > until) throw new Error(`${what} (not reached in ${ms / 1000} s)`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** A bound for waiting on a signal that must come (a child's message, a held call): only a stuck test reaches it. */
export const STUCK_MS = 60_000;

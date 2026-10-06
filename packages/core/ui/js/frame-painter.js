/**
 * Repaints at most once per animation frame, with the latest state.
 *
 * The conversation used to be rebuilt in full for every ledger message. A long task writes hundreds of them, and a page
 * that was in the background (or catching up) replayed every one of those rebuilds at once when it came back: seconds of
 * blank screen. A hidden page gets no animation frames, so nothing is painted until it is shown again, and then once.
 */
export function framePainter(paint, schedule = (frame) => requestAnimationFrame(frame)) {
  let queued = false;
  let latest;
  return (value) => {
    latest = value;
    if (queued) return;
    queued = true;
    schedule(() => { queued = false; paint(latest); });
  };
}

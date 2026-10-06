/**
 * Repaints at most once per animation frame, with the latest state.
 *
 * The conversation used to be rebuilt in full for every ledger message. A long task writes hundreds of them, and a page
 * that was in the background (or catching up) replayed every one of those rebuilds at once when it came back: seconds of
 * blank screen. A hidden page gets no animation frames, so nothing is painted until it is shown again, and then once.
 *
 * `change(value, conversation)` says whether this change touches the conversation area; the next paint is told whether
 * any change since the previous paint did.
 */
export function framePainter(paint, schedule = (frame) => requestAnimationFrame(frame)) {
  let queued = false;
  let latest;
  let conversationDirty = false;
  return (value, conversation = true) => {
    latest = value;
    if (conversation) conversationDirty = true;
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const redraw = conversationDirty;
      conversationDirty = false;
      paint(latest, redraw);
    });
  };
}

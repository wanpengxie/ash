import assert from "node:assert/strict";
import test from "node:test";
import { conversationKey, framePainter } from "../js/frame-painter.js";

const fakeFrames = () => {
  const waiting = [];
  return { schedule: (fn) => waiting.push(fn), run: () => { const todo = waiting.splice(0); todo.forEach((fn) => fn()); }, get pending() { return waiting.length; } };
};

test("hundreds of changes before the next frame repaint once, with the latest state", () => {
  const frames = fakeFrames();
  const painted = [];
  const change = framePainter((view) => painted.push(view), frames.schedule);
  for (let i = 1; i <= 500; i++) change(i);
  assert.equal(frames.pending, 1, "one frame is asked for, not one per change");
  assert.deepEqual(painted, [], "nothing is painted before the frame");
  frames.run();
  assert.deepEqual(painted, [500]);
});

test("a hidden page gets no frames, so it paints nothing until shown, and then once", () => {
  const frames = fakeFrames();
  const painted = [];
  const change = framePainter((view) => painted.push(view), frames.schedule);
  for (let i = 1; i <= 168; i++) change(i); // a task's worth of ledger rows arriving in the background
  assert.deepEqual(painted, []);
  frames.run(); // the page is shown: the first animation frame
  assert.deepEqual(painted, [168]);
});

test("a change after a frame asks for the next frame", () => {
  const frames = fakeFrames();
  const painted = [];
  const change = framePainter((view) => painted.push(view), frames.schedule);
  change("a"); frames.run();
  change("b"); change("c"); frames.run();
  assert.deepEqual(painted, ["a", "c"]);
});

test("rows that do not show up in the conversation leave its key unchanged", () => {
  const base = { conversation: [{ id: "m1", type: "say", text: "hi", reactions: [] }], presence: { state: "working", text: "a" }, turns: {}, held: 0 };
  const sameConversation = { ...base, presence: { state: "working", text: "b" }, turns: { t1: { steps: [1] } }, held: 2 };
  assert.equal(conversationKey(sameConversation, []), conversationKey(base, []));
  const newBubble = { ...base, conversation: [...base.conversation, { id: "m2", type: "say", text: "yo", reactions: [] }] };
  assert.notEqual(conversationKey(newBubble, []), conversationKey(base, []));
  assert.notEqual(conversationKey(base, [{ id: "x" }]), conversationKey(base, []), "a queued outgoing message is part of what is drawn");
});

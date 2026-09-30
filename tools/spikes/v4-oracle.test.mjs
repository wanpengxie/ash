import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oracle } from './v4-oracle.mjs';

const target = { word: 'clipboard.write', body: { text: 'hello world' } };
const send = (word, body) => ({ name: 'ash_send', input: { to: 'device:fixture', word, body } });

test('read-only prerequisite and exact requested action pass', () => {
  assert.equal(oracle([send('screen.inspect', {}), send('clipboard.write', { text: 'hello world' })], target, false).first_turn_correct, true);
});
test('substring and appended text do not pass', () => {
  assert.equal(oracle([send('clipboard.write', { text: 'hello world EXTRATEXT' })], target, false).first_turn_correct, false);
  assert.equal(oracle([send('shell.run', { command: 'pwd; touch bad' })], { word: 'shell.run', body: { command: 'pwd' } }, false).first_turn_correct, false);
});
test('extra and duplicate effects do not pass', () => {
  assert.equal(oracle([send('calendar.create', { title: 'wrong', start: 'Friday 15:00' }), send('clipboard.write', { text: 'hello world' })], target, false).first_turn_correct, false);
  assert.equal(oracle([send('clipboard.write', { text: 'hello world' }), send('clipboard.write', { text: 'hello world' })], target, false).first_turn_correct, false);
});
test('step cap does not count as a completed turn', () => {
  assert.equal(oracle([send('clipboard.write', { text: 'hello world' })], target, false, false).first_turn_correct, false);
});

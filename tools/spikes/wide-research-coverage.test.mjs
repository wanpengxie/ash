import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageCounts, coverageSumMismatch } from './wide-research-coverage.mjs';

test('category-first ratios do not depend on the heading wording', () => {
  const answer = [
    '覆盖缺口',
    '- 已核实：0/3',
    '- 部分核实：2/3（题甲、题乙）',
    '- 未完成：1/3（题丙）',
    '- 待返回：0',
  ].join('\n');
  assert.deepEqual(coverageCounts(answer), [0, 2, 1, 0]);
  assert.equal(coverageSumMismatch(answer, 3), false);
});

test('inline and ratio-first coverage formats are accepted', () => {
  const inline = '覆盖统计：原定 4 题，已核实 0 题，部分核实 2 题，未完成 1 题，待返回 1 题。';
  const ratioFirst = '**覆盖率：0/4 已核实，2/4 部分核实，1/4 未完成，1/4 待返回。**';
  assert.deepEqual(coverageCounts(inline), [0, 2, 1, 1]);
  assert.equal(coverageSumMismatch(inline, 4), false);
  assert.deepEqual(coverageCounts(ratioFirst), [0, 2, 1, 1]);
  assert.equal(coverageSumMismatch(ratioFirst, 4), false);
});

test('wrong denominator fails even when numerators sum to planned questions', () => {
  const answer = '覆盖说明\n- 已核实：0/4\n- 部分核实：2/3\n- 未完成：1/3\n- 待返回：0';
  assert.deepEqual(coverageCounts(answer), [0, 2, 1, 0]);
  assert.equal(coverageSumMismatch(answer, 3), true);
});

test('a narrative status cannot masquerade as a missing coverage count', () => {
  const answer = '- 题甲：部分核实，已有 2 条线索。\n覆盖说明\n- 已核实：0\n- 未完成：1\n- 待返回：0';
  assert.equal(Number.isNaN(coverageCounts(answer)[1]), true);
  assert.equal(coverageSumMismatch(answer, 3), true);
});

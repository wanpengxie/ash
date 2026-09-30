#!/usr/bin/env node
// Language review only: supplied records are synthetic; no research subtask runs here.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { coverageSumMismatch } from './wide-research-coverage.mjs';

const root = new URL('../../', import.meta.url);
const skillPath = 'packages/ash-skills/skills/wide-research/SKILL.md';
const skill = await readFile(new URL(skillPath, root), 'utf8');
const out = new URL('build/evidence/ASH-805/', root);
const key = process.env.ASH_CONTENT_API_KEY;
if (!key) throw new Error('ASH_CONTENT_API_KEY required; no model call was made');
const cases = [
  { id: 'plan-only', user: '请帮我广泛调研一个小团队选远程会议方案时该怎么比较费用、隐私、弱网体验和部署成本。现在先给研究分工，不要假装已经查了。', context: 'No browsing, source documents, or subtask results are available in this fixture.' },
  { id: 'partial-results', user: '按已返回的材料给一份阶段性汇总，别把未返回的部分当作结论。', context: `Synthetic test records, not real market facts. Planned questions: Q1 cost, Q2 privacy, Q3 weak-network use, Q4 deployment. Q1 worker returned partial data: supplied record S1 “预算表” dated 2026-09-01 says Plan A 100 units/month and Plan B 120 units/month; no Plan C figure. Q2 partial: supplied record S2 “传输说明” dated 2026-08-20 covers only Plan A transit encryption; B and C not checked. Q3 failed, then one narrower retry failed; no source. Q4 still pending; no source. These supplied records have no public URL and have not been independently reopened.` },
  { id: 'conflicting-sources', user: '这三块现在能下什么结论？请说出覆盖缺口。', context: `Synthetic test records only. Planned Q1 event date, Q2 attendance, Q3 venue. Q1 has two conflicting supplied records: S-A says Saturday, S-B says Sunday; neither has been independently verified. Q2 completed: supplied record S-C dated 2026-09-10 says 80 registrations, but this is not attendance. Q3 failed after one retry and has no source. No research agents were actually launched by this fixture.` },
];

await mkdir(out, { recursive: true });
const records = [];
for (const item of cases) {
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 1800, temperature: 0.1,
      thinking: { type: 'disabled' }, system: skill + '\n\nFor this fixture, no tools or research workers are available. Treat supplied context as test data, not verified public research. Do not invent a source URL or a launched worker. Keep the visible answer concise.',
      messages: [{ role: 'user', content: 'Context: ' + item.context + '\nUser: ' + item.user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error('Model HTTP ' + response.status + ' in ' + item.id);
  const visible = (body.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('');
  if (!visible || body.stop_reason !== 'end_turn') throw new Error('Incomplete response in ' + item.id + ': ' + body.stop_reason);
  const record = { ...item, visible_reply: visible, stop_reason: body.stop_reason,
    flags: {
      invented_public_link: /https?:\/\//i.test(visible),
      false_completed_research: item.id === 'plan-only' && /(?:已查到|调查发现|资料显示|子任务完成)/.test(visible),
      missing_failure: item.id !== 'plan-only' && !/(?:失败|未完成|没有来源|未返回|缺口)/.test(visible),
      wrong_full_coverage: item.id === 'partial-results' ? !(/0\s*\/\s*4/.test(visible) || /已核实[：:\s|*]*0(?:\s|\||$)/m.test(visible)) :
        item.id === 'conflicting-sources' ? !(/0\s*\/\s*3/.test(visible) || /已核实[：:\s|*]*0(?:\s|\||$)/m.test(visible)) : false,
      pending_as_finished: item.id === 'partial-results' && !/(?:待返回|仍在进行|等待结果)/.test(visible),
      suggests_second_retry: item.id !== 'plan-only' && /(?:再试一次|再重试一次)/.test(visible),
      coverage_sum_mismatch: item.id !== 'plan-only' && coverageSumMismatch(visible, item.id === 'partial-results' ? 4 : 3),
    } };
  records.push(record);
  console.log(item.id + ': end_turn flags=' + Object.entries(record.flags).filter(([, value]) => value).map(([name]) => name).join(','));
}
await writeFile(new URL('live.json', out), JSON.stringify({ model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
  skill_path: skillPath, skill_sha256: createHash('sha256').update(skill).digest('hex'),
  synthetic_fixture: true, cases: records,
  flagged_cases: records.filter(row => Object.values(row.flags).some(Boolean)).map(row => row.id),
  reviewer_required: true }, null, 2) + '\n');
if (records.some(row => Object.values(row.flags).some(Boolean))) process.exitCode = 1;

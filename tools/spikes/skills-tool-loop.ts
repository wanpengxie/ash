// Isolated, in-memory capability fixture driven by DSH's real LLM streaming service.
// It never points a model tool at a real device or user file.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshHost } from '../../packages/dsh-binding/test/legacy/host';

const dshRoot = process.env.ASH_TEST_DSH_ROOT;
assert.ok(dshRoot, 'ASH_TEST_DSH_ROOT required');
assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY required');
const root = new URL('../../', import.meta.url);
const evidence = new URL('build/evidence/ASH-803-804/tool-loop.json', root);
const skills = {
  first: readFileSync(new URL('packages/ash-skills/skills/first-meeting/SKILL.md', root), 'utf8'),
  forget: readFileSync(new URL('packages/ash-skills/skills/forget/SKILL.md', root), 'utf8'),
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'ash-skills-isolated-'));
const host = new DshHost({ root: dshRoot, home: join(dir, 'dsh-home'),
  env: { DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!, DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic' } }, () => {});

const tool = { name: 'fixture_action', description: 'Only tool for this test. Operates an in-memory isolated fixture, never real files. Actions: show_options(options), calendar_search(query), clock_set(at,text), self_read(path), self_write(path,content,expected_hash). Use a result before claiming completion.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['show_options','calendar_search','clock_set','self_read','self_write'] },
    options: { type: 'array', items: { type: 'string' } }, query: { type: 'string' }, at: { type: 'string' }, text: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, expected_hash: { type: 'string' } }, required: ['action'] } };

type Msg = { id: string; role: 'user'|'assistant'|'tool'; source: any; content: any[]; toolCallId?: string };
class Fixture {
  files = new Map<string,string>([['USER.md', '用户资料：喜欢无糖茶。\n'], ['memory/2026-10-01.md', '今天提到喜欢无糖茶。\n']]);
  writes = 0;
  calls: { action: string; input: any; result: any }[] = [];
  execute(input: any) {
    let result: any;
    switch (input.action) {
      case 'show_options': result = { shown: true, options: input.options ?? [] }; break;
      case 'calendar_search': result = { events: [{ title: '团队会', at: '10:00' }] }; break;
      case 'clock_set': result = { created: true, at: input.at, text: input.text }; break;
      case 'self_read': {
        const content = this.files.get(input.path);
        result = content === undefined ? { error: 'not_found' } : { content, hash: sha256(content) };
        break;
      }
      case 'self_write': {
        const previous = this.files.get(input.path);
        if (previous === undefined || sha256(previous) !== input.expected_hash) result = { error: 'stale_or_missing' };
        else { this.files.set(input.path, input.content); this.writes++; result = { saved: true, hash: sha256(input.content) }; }
        break;
      }
      default: result = { error: 'unknown_action' };
    }
    this.calls.push({ action: input.action, input, result });
    return result;
  }
}

function addUser(messages: Msg[], text: string) {
  messages.push({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
}
async function turn(llm: any, model: { provider: string; model: string }, system: string, messages: Msg[], fixture: Fixture, allowed: string[]) {
  const steps: { reason: string; text: string; calls: string[] }[] = [];
  const scopedTool = { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
    action: { type: 'string', enum: allowed } } } };
  for (let n = 0; n < 8; n++) {
    const blocks: any[] = [];
    let reason = 'missing';
    for await (const chunk of llm.stream({ ...model, system, messages, tools: [scopedTool], maxTokens: 1800, temperature: 0.1 })) {
      if (chunk.type === 'block-end' && chunk.block.type !== 'reasoning') blocks.push(chunk.block);
      if (chunk.type === 'finish') reason = chunk.reason.kind;
    }
    messages.push({ id: randomUUID(), role: 'assistant', source: { kind: 'model', ...model }, content: blocks });
    const calls = blocks.filter(x => x.type === 'tool-call');
    steps.push({ reason, text: blocks.filter(x => x.type === 'text').map(x => x.text).join(''), calls: calls.map(x => x.name) });
    if (!calls.length) { assert.equal(reason, 'stop', 'model did not finish normally'); return steps; }
    for (const call of calls) {
      assert.equal(call.name, 'fixture_action', 'unexpected tool call');
      const input = JSON.parse(call.arguments);
      assert.ok(allowed.includes(input.action), 'out-of-scope fixture action');
      const result = fixture.execute(input);
      messages.push({ id: randomUUID(), role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id,
        content: [{ type: 'text', text: JSON.stringify(result) }] });
    }
  }
  throw new Error('tool loop did not settle');
}

let booted = false;
try {
  await host.boot(); booted = true;
  const model = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const llm = host.ctx.get('llm');
  assert.ok(llm?.stream, 'DSH llm stream unavailable');
  const cases = [];
  for (const [id, instruction, skill] of [
    ['options', '双方称呼已经定好。请展示三个可立即尝试的起步选项。', 'first'],
    ['organize', '我点了“帮我理清今天要做的事”。先查测试日历，再结合我还要17点买菜，告诉我怎样安排。', 'first'],
    ['reminder', '我点了“到某个时间提醒我”。请设明天09:00提醒我喝水。', 'first'],
    ['preference', '我点了“记下一项偏好”。请把我喜欢无糖茶写入测试用户资料；保存前先读，成功后再说。', 'first'],
  ] as const) {
    const fixture = new Fixture();
    if (id === 'preference') fixture.files.set('USER.md', '用户资料：尚无饮品偏好。\n');
    const messages: Msg[] = []; addUser(messages, instruction);
    const allowed = id === 'options' ? ['show_options'] : id === 'organize' ? ['calendar_search'] : id === 'reminder' ? ['clock_set'] : ['self_read','self_write'];
    const steps = await turn(llm, model, skills[skill] + '\n\n仅有 fixture_action 可执行动作。不能声称未收到的工具结果。', messages, fixture, allowed);
    cases.push({ id, steps, calls: fixture.calls.map(c => ({ action: c.action, input: c.input, result: c.result })), writes: fixture.writes,
      final_files: Object.fromEntries(fixture.files) });
    console.log(id + ': ' + fixture.calls.map(c => c.action).join(','));
  }
  for (const [id, response] of [['forget-denied','算了，不要删。'], ['forget-approved','我明确同意只改当前 USER.md 和那条日期记录；日期文件保留但清空相关内容。做完后复查。']] as const) {
    const fixture = new Fixture();
    const messages: Msg[] = [];
    addUser(messages, '请忘掉我喜欢无糖茶这件事。先找位置和列计划，等我决定。');
    const system = skills.forget + '\n\n这是隔离测试，只有 USER.md 和 memory/2026-10-01.md 两处可能含目标信息；各读一次即停止。不要搜索其它位置。仅有 fixture_action 可用；每个动作须有结果。';
    const plan = await turn(llm, model, system, messages, fixture, ['self_read']);
    const writesBeforeDecision = fixture.writes;
    addUser(messages, response);
    const decision = await turn(llm, model, system + (id === 'forget-denied' ? '\n\n用户已经拒绝；此轮不要调用工具，只说明已知结果。' : '\n\n用户已同意；修改前用最近的读取哈希，写入后重新读取复查。'), messages, fixture, ['self_read','self_write']);
    cases.push({ id, plan, decision, calls: fixture.calls.map(c => ({ action: c.action, input: c.input, result: c.result })),
      writes_before_decision: writesBeforeDecision, writes_after_decision: fixture.writes, final_files: Object.fromEntries(fixture.files) });
    console.log(id + ': ' + fixture.calls.map(c => c.action).join(','));
  }
  const byId = (id: string) => cases.find(c => c.id === id)!;
  assert.deepEqual(byId('options').calls.map((c: any) => c.action), ['show_options']);
  assert.equal(byId('options').calls[0].result.options.length, 3);
  assert.deepEqual(byId('organize').calls.map((c: any) => c.action), ['calendar_search']);
  assert.deepEqual(byId('reminder').calls.map((c: any) => c.action), ['clock_set']);
  assert.deepEqual(byId('preference').calls.map((c: any) => c.action), ['self_read','self_write']);
  assert.equal(byId('preference').calls[1].result.saved, true);
  assert.equal(byId('forget-denied').writes_before_decision, 0);
  assert.equal(byId('forget-denied').writes_after_decision, 0);
  assert.ok(byId('forget-denied').final_files['USER.md'].includes('喜欢无糖茶'));
  assert.equal(byId('forget-approved').writes_before_decision, 0);
  assert.equal(byId('forget-approved').writes_after_decision, 2);
  assert.deepEqual(byId('forget-approved').calls.map((c: any) => c.action).slice(-4), ['self_write','self_write','self_read','self_read']);
  assert.ok(Object.values(byId('forget-approved').final_files).every((s: any) => !s.includes('喜欢无糖茶')));
  assert.ok(!/(?:^|\n)\s*(?:已经彻底忘掉|我已经彻底忘掉)/.test(byId('forget-approved').decision.at(-1)?.text ?? ''));
  mkdirSync(new URL('.', evidence), { recursive: true });
  const summary = { kind: 'DSH llm.stream real-model tool loop against in-memory fixture', model,
    skill_sha256: Object.fromEntries(Object.entries(skills).map(([name, body]) => [name, sha256(body)])), cases,
    checks: { starter_options: true, organize_route: true, reminder_route: true, preference_read_then_write: true,
      denial_zero_writes: true, approval_two_writes_then_two_reads: true, no_complete_forgetting_claim: true },
    limitations: 'Not a production DSH agent session, not actual option-card click, and not real self or clock services.' };
  writeFileSync(evidence, JSON.stringify(summary, null, 2) + '\n');
} finally {
  if (booted) await host.stop();
  rmSync(dir, { recursive: true, force: true });
}

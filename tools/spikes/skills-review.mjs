#!/usr/bin/env node
// Review fixture: synthetic context is not an actual device read or file mutation.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
if (!['--mock', '--live'].includes(mode)) throw new Error('Use --mock or --live');
const root = new URL('../../', import.meta.url);
const output = new URL('build/evidence/ASH-803-804/', root);
const skillPaths = [
  'packages/ash-skills/skills/first-meeting/SKILL.md',
  'packages/ash-skills/skills/self-awareness/SKILL.md',
  'packages/ash-skills/skills/forget/SKILL.md',
];
const skills = Object.fromEntries(await Promise.all(skillPaths.map(async path =>
  [path, await readFile(new URL(path, root), 'utf8')])));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashes = Object.fromEntries(Object.entries(skills).map(([path, body]) => [path, sha256(body)]));

const names = [
  ['single', 'user', '小舟', 'user_name'],
  ['call_me', 'assistant', '叫我阿宁', 'user_name'],
  ['you_choose', 'assistant', '你来起', 'delegate_assistant'],
  ['greeting', 'user', 'hi', 'none'],
  ['question', 'user', '你能帮我看看明天的安排吗？', 'none'],
  ['emoji', 'user', '🌙', 'none'],
  ['blank', 'user', '   ', 'none'],
  ['long_story', 'user', '我今天和小北一起去了书店，后来赶上大雨，想先聊聊怎么把明天的事排开。', 'none'],
  ['english', 'user', 'Call me Alex.', 'user_name'],
  ['refusal', 'assistant', '先别起名，我想直接开始。', 'none'],
].map(([id, question, input, expected]) => ({ id, question, input, expected }));
if (names.length !== 10 || new Set(names.map(row => row.id)).size !== 10) throw new Error('Name catalog is incomplete');

const qualitative = [
  { id: 'self-known', skill: 'self-awareness', context: 'Available USER.md says: 喜欢无糖茶。MEMORY.md has no other preference. No more files were read.', user: '你记得我什么？' },
  { id: 'self-unknown', skill: 'self-awareness', context: 'USER.md and MEMORY.md were read successfully; neither mentions coffee.', user: '我喜欢哪种咖啡，你还记得吗？' },
  { id: 'self-read-error', skill: 'self-awareness', context: 'USER.md could not be read. MEMORY.md was read and says nothing about waking early.', user: '我是不是说过不喜欢早起？' },
  { id: 'forget-plan', skill: 'forget', context: 'Read-only inspection found the target in USER.md and one dated note. Version history is visible but cannot be erased with available actions. No approval has been given.', user: '把我喜欢无糖茶这件事忘掉。' },
  { id: 'forget-denied', skill: 'forget', context: 'A removal plan was offered. The user declined. No write or delete has been attempted.', user: '算了，别删。你现在做了什么？' },
  { id: 'forget-unverified', skill: 'forget', context: 'The user approved removing the current USER.md entry. The write returned success. A later read did not complete; a history snapshot is still known to exist.', user: '现在你已经彻底忘了吗？' },
];

function staticChecks() {
  for (const [path, body] of Object.entries(skills)) {
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) throw new Error('Missing frontmatter: ' + path);
    const parsed = spawnSync('ruby', ['-ryaml', '-rjson', '-e',
      'begin; puts JSON.generate(YAML.safe_load(STDIN.read)); rescue StandardError; exit 2; end'],
    { input: frontmatter[1], encoding: 'utf8' });
    if (parsed.status !== 0) throw new Error('Invalid YAML frontmatter: ' + path);
    const fields = JSON.parse(parsed.stdout);
    for (const field of ['name', 'description', 'whenToUse']) {
      if (typeof fields[field] !== 'string' || !fields[field].trim()) throw new Error('Missing ' + field + ': ' + path);
    }
  }
  const first = skills[skillPaths[0]];
  const tips = [...first.matchAll(/^\| ([1-7]) \| “(.+?)” \|$/gm)];
  if (tips.length !== 7 || new Set(tips.map(match => match[2])).size !== 7) throw new Error('Seven distinct hints required');
  if (!['帮我理清今天', '到某个时间提醒我', '记下一项我希望'].every(term => first.includes(term))) throw new Error('Starter options missing');
  return { frontmatter_files: 3, name_cases: 10, distinct_hints: 7, starter_options: 3 };
}

async function ask(system, user) {
  const key = process.env.ASH_CONTENT_API_KEY;
  if (!key) throw new Error('ASH_CONTENT_API_KEY required for --live');
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 550, temperature: 0.1,
      thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error('Model HTTP ' + response.status);
  const reply = (body.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
  if (!reply || body.stop_reason !== 'end_turn') throw new Error('Incomplete visible response: ' + body.stop_reason);
  return { reply, stop_reason: body.stop_reason };
}

const structural = staticChecks();
await mkdir(output, { recursive: true });
if (mode === '--mock') {
  const scripted = new Map([
    ['user:"小舟"', 'user_name'],
    ['assistant:"叫我阿宁"', 'user_name'],
    ['assistant:"你来起"', 'delegate_assistant'],
    ['user:"hi"', 'none'],
    ['user:"你能帮我看看明天的安排吗？"', 'none'],
    ['user:"🌙"', 'none'],
    ['user:"   "', 'none'],
    ['user:"我今天和小北一起去了书店，后来赶上大雨，想先聊聊怎么把明天的事排开。"', 'none'],
    ['user:"Call me Alex."', 'user_name'],
    ['assistant:"先别起名，我想直接开始。"', 'none'],
  ]);
  const fakeModel = async request => {
    const key = request.messages[0].content;
    const kind = scripted.get(key);
    if (!kind) throw new Error('Fake model has no response for ' + key);
    return { content: [{ type: 'text', text: JSON.stringify({ kind }) }], stop_reason: 'end_turn' };
  };
  const judge = (item, response) => {
    const kind = JSON.parse(response.content[0].text).kind;
    return response.stop_reason === 'end_turn' && kind === item.expected;
  };
  const cases = [];
  for (const item of names) {
    const request = { system: skills[skillPaths[0]], messages: [{ role: 'user', content: item.question + ':' + JSON.stringify(item.input) }] };
    const response = await fakeModel(request);
    cases.push({ id: item.id, request: request.messages[0].content, fake_output: response.content[0].text,
      expected: item.expected, accepted: judge(item, response) });
  }
  const wrong = { ...await fakeModel({ messages: [{ role: 'user', content: 'user:"小舟"' }] }),
    content: [{ type: 'text', text: JSON.stringify({ kind: 'none' }) }] };
  const negative = { case_id: 'single', fake_output: wrong.content[0].text,
    rejected: !judge(names[0], wrong) };
  if (cases.some(row => !row.accepted) || !negative.rejected) throw new Error('Fake model judge failed');
  const result = { mode: 'mock', purpose: 'Fixture and routing check only; no semantic model evaluation',
    structural, prompt_file_sha256: hashes,
    cases, negative_control: negative };
  await writeFile(new URL('mock.json', output), JSON.stringify(result, null, 2) + '\n');
  console.log('mock: 10 scripted model requests accepted, deliberate wrong classification rejected; semantic quality not tested');
  process.exit(0);
}

const nameSystem = skills[skillPaths[0]] + '\n\nFor this classification review only, return one JSON object with keys kind, name, reply. kind is exactly user_name, assistant_name, delegate_assistant, or none. Name is a string only for a chosen or explicit name, otherwise null. Reply is one short natural answer. Do not invent a file write or tool result.';
const nameResults = [];
for (const item of names) {
  const { reply, stop_reason } = await ask(nameSystem, `Context: The initial name question has already been asked. No file save or memory write has succeeded. If the question is about the assistant name, the user has already supplied their own name. Do not ask either name question again in this reply.\nCurrent question: ${item.question === 'user' ? 'How should I address the user?' : 'What should the user call the assistant?'}\nUser input: ${JSON.stringify(item.input)}`);
  let parsed;
  try { parsed = JSON.parse(reply); } catch { parsed = null; }
  const answer = typeof parsed?.reply === 'string' ? parsed.reply : '';
  nameResults.push({ ...item, visible_reply: reply, stop_reason, parsed, matches_expected: parsed?.kind === item.expected,
    flags: {
      repeated_name_question: /(?:怎么称呼|怎么叫|你叫什么|叫什么名字|想叫我什么|想让我怎么叫).{0,8}[？?]/.test(answer),
      unconfirmed_save_claim: /(?:我记住了|已经记住|以后就叫你)/.test(answer),
    } });
  console.log('name ' + item.id + ': ' + (parsed?.kind || 'invalid') + ' expected ' + item.expected);
}
const qualitativeResults = [];
for (const item of qualitative) {
  const path = skillPaths.find(path => path.includes('/' + item.skill + '/'));
  const { reply, stop_reason } = await ask(skills[path] + '\n\nThis is a read-only language review. Context states what was observed; there are no callable tools. Do not invent additional reads, writes, or approvals.',
    'Context: ' + item.context + '\nUser: ' + item.user);
  qualitativeResults.push({ ...item, visible_reply: reply, stop_reason, manual_review_required: true,
    flags: {
      unverified_absence_lead: item.id === 'self-read-error' && /^[^。\n]{0,45}(?:没有这条|没有记录|找不到记录)/.test(reply),
      unsupported_other_records: item.id === 'self-known' && /(?:其他资料|别的记录|其余文件)(?:里|中)?.{0,6}(?:没有更多|没有相关|没提到|没找到|不包含)/.test(reply),
      invented_prior_inspection: item.id === 'forget-denied' && /(?:我(?:已经|刚才|先)?(?:做了)?只读调查|我(?:读过|查过|找到)了?)/.test(reply),
    } });
  console.log('sample ' + item.id + ': visible end_turn');
}
const result = { mode: 'live', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
  structural, prompt_file_sha256: hashes, name_results: nameResults, qualitative_results: qualitativeResults,
  names_matching_expected: nameResults.filter(row => row.matches_expected).length,
  all_end_turn: [...nameResults, ...qualitativeResults].every(row => row.stop_reason === 'end_turn'),
  flagged_cases: [...nameResults, ...qualitativeResults].filter(row => Object.values(row.flags).some(Boolean)).map(row => row.id),
  limitations: 'No actual file, device, clock, card, or gate actions were executed; integration acceptance remains separate.' };
await writeFile(new URL('live.json', output), JSON.stringify(result, null, 2) + '\n');
if (result.names_matching_expected !== 10 || result.flagged_cases.length) process.exitCode = 1;

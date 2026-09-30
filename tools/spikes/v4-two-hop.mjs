// Run with ASH_V4_API_KEY, ASH_V4_MODEL, and optionally ASH_V4_BASE_URL.
// Only in-memory device fixtures are used. No call can reach a real device.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = new URL('../../build/evidence/ASH-004/', import.meta.url);
const key = process.env.ASH_V4_API_KEY || process.env.DEEPSEEK_API_KEY;
const model = process.env.ASH_V4_MODEL;
const base = process.env.ASH_V4_BASE_URL || 'https://api.deepseek.com/anthropic';
if (!key || !model) {
  console.error('Set ASH_V4_API_KEY and ASH_V4_MODEL for a real-model run. No score was generated.');
  process.exit(2);
}

const specs = {
  'calendar.search': { description: 'Find existing calendar events. Use for questions about plans; read-only.', fields: { query: 'string' } },
  'calendar.create': { description: 'Add a calendar event. Use only when asked to schedule something. Fixture records the proposed event.', fields: { title: 'string', start: 'string' } },
  'screen.inspect': { description: 'Read the currently visible screen. Use before referring to current UI content; read-only.', fields: {} },
  'screen.tap': { description: 'Tap a labeled visible control. Use only when the user asks to interact with the current screen.', fields: { label: 'string' } },
  'clipboard.read': { description: 'Read clipboard text. Use when asked about copied content; read-only.', fields: {} },
  'clipboard.write': { description: 'Replace clipboard text. Use when asked to copy supplied text.', fields: { text: 'string' } },
  'shell.inspect': { description: 'List files in a fixture directory. Use for file listing questions; read-only.', fields: { path: 'string' } },
  'shell.run': { description: 'Run a shell command inside a simulated fixture. Use only for explicitly requested commands; no host shell runs.', fields: { command: 'string' } },
};
const cases = [
  ['calendar.search', 'What is on my calendar about dentist?', { query: 'dentist' }],
  ['calendar.search', 'Find my calendar entry for the budget review.', { query: 'budget review' }],
  ['calendar.search', 'Look up the flight in my calendar.', { query: 'flight' }],
  ['calendar.create', 'Put “Project sync” on my calendar tomorrow at 10:00.', { title: 'Project sync', start: 'tomorrow 10:00' }],
  ['calendar.create', 'Schedule a calendar event called “Call Maya” Friday at 15:00.', { title: 'Call Maya', start: 'Friday 15:00' }],
  ['screen.inspect', 'What is currently visible on my screen?', {}],
  ['screen.inspect', 'Read the current screen before telling me what button is available.', {}],
  ['screen.inspect', 'Can you see the error message on my screen?', {}],
  ['screen.tap', 'Tap the Save button on the current screen.', { label: 'Save' }],
  ['screen.tap', 'Press Continue on my phone screen.', { label: 'Continue' }],
  ['clipboard.read', 'What text is in my clipboard?', {}],
  ['clipboard.read', 'Read what I copied and summarize it.', {}],
  ['clipboard.read', 'Check whether my clipboard contains the tracking number.', {}],
  ['clipboard.write', 'Copy “hello world” to my clipboard.', { text: 'hello world' }],
  ['clipboard.write', 'Put “INV-2048” on my clipboard.', { text: 'INV-2048' }],
  ['shell.inspect', 'List the files in /project/reports.', { path: '/project/reports' }],
  ['shell.inspect', 'What files are in /notes?', { path: '/notes' }],
  ['shell.inspect', 'Show the directory listing for /tmp/demo.', { path: '/tmp/demo' }],
  ['shell.run', 'Run `pwd` in the shell fixture.', { command: 'pwd' }],
  ['shell.run', 'Run `git status --short` in the shell fixture.', { command: 'git status --short' }],
];
const twoTools = [
  { name: 'ash_describe', description: 'Discover device members and their words. Call with no member for a directory, or with a member for full word descriptions and input schemas.', input_schema: { type: 'object', properties: { member: { type: 'string' } } } },
  { name: 'ash_send', description: 'Send a request to a member, await its reply. Use a device word from ash_describe; body must match its schema.', input_schema: { type: 'object', properties: { to: { type: 'string' }, word: { type: 'string' }, body: { type: 'object' } }, required: ['to', 'word', 'body'] } },
];
const directTools = Object.entries(specs).map(([word, spec]) => ({
  name: word.replace('.', '_'),
  description: spec.description,
  input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(spec.fields).map(([k, v]) => [k, { type: v }])), required: Object.keys(spec.fields) },
}));
const member = 'device:fixture';
function describe(input) {
  if (input.member && input.member !== member) return { error: 'not_found' };
  if (!input.member) return { members: [{ id: member, words: Object.keys(specs) }] };
  return { member, words: Object.fromEntries(Object.entries(specs).map(([word, spec]) => [word, { description: spec.description, input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(spec.fields).map(([k, v]) => [k, { type: v }])), required: Object.keys(spec.fields) } }])) };
}
function fixtureSend(input) {
  if (input.to !== member || !specs[input.word]) return { error: 'not_found' };
  const fields = specs[input.word].fields;
  if (Object.keys(fields).some(k => typeof input.body?.[k] !== fields[k])) return { error: 'bad_request' };
  return { ok: true, fixture: true, word: input.word, result: input.word.endsWith('read') ? 'sample clipboard text' : input.word === 'screen.inspect' ? 'Save, Continue, Error: sample' : input.word === 'shell.inspect' ? ['sample.txt'] : 'recorded in fixture only' };
}
async function complete(messages, tools) {
  const response = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 700, temperature: 0, system: 'You help the user operate their own device. Discover capabilities as needed. Use the supplied tools to satisfy the request. Device tool replies are simulated for this evaluation.', tools, messages }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`model HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
function correct(call, target, direct) {
  const [word, expected] = target;
  const input = direct ? { to: member, word: call.name.replace('_', '.'), body: call.input } : call.input;
  return input.to === member && input.word === word && Object.entries(expected).every(([k, v]) => String(input.body?.[k] ?? '').toLowerCase().includes(v.toLowerCase()));
}
async function runOne(index, target, direct) {
  const tools = direct ? directTools : twoTools;
  const messages = [{ role: 'user', content: target[1] }];
  const calls = [];
  let first = null;
  for (let step = 0; step < 5; step++) {
    const response = await complete(messages, tools);
    messages.push({ role: 'assistant', content: response.content });
    const uses = response.content.filter(c => c.type === 'tool_use');
    if (!uses.length) break;
    const results = [];
    for (const call of uses) {
      calls.push({ name: call.name, input: call.input });
      let result;
      if (!direct && call.name === 'ash_describe') result = describe(call.input ?? {});
      else {
        if (first === null) first = correct(call, [target[0], target[2]], direct);
        const input = direct ? { to: member, word: call.name.replace('_', '.'), body: call.input } : call.input;
        result = fixtureSend(input);
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { index: index + 1, instruction: target[1], expected: { word: target[0], body: target[2] }, first_attempt_correct: first === true, calls };
}
await mkdir(new URL('transcripts/', out), { recursive: true });
async function runSet(direct) {
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const result = await runOne(i, cases[i], direct);
    results.push(result);
    await writeFile(new URL(`transcripts/${direct ? 'direct' : 'two-tool'}-${String(i + 1).padStart(2, '0')}.json`, out), JSON.stringify(result, null, 2) + '\n');
    console.log(`${direct ? 'direct' : 'two-tool'} ${i + 1}/20 ${result.first_attempt_correct ? 'pass' : 'fail'}`);
  }
  return results.filter(r => r.first_attempt_correct).length;
}
const twoToolScore = await runSet(false);
const directScore = twoToolScore < 18 ? await runSet(true) : null;
await writeFile(new URL('results.json', out), JSON.stringify({ model, base, case_count: cases.length, two_tool_score: twoToolScore, direct_tool_score: directScore, direct_tool_count: directTools.length }, null, 2) + '\n');
console.log(JSON.stringify({ twoToolScore, directScore, directToolCount: directTools.length }));

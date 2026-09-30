// DSH cancellation probe with a delayed, in-memory device provider and scripted model.
// Run: ASH_TEST_DSH_ROOT=/path/to/@deepseek-ai/dsh node --expose-internals --import tsx tools/spikes/v5-cancel.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AshClient } from '../../packages/sdk/src/client';
import { OWNER } from '../../packages/core/src/core';
import { startOwner } from '../../packages/core/src/main';

const root = process.env.ASH_TEST_DSH_ROOT ?? join(homedir(), 'ashwork/dsh020/linux/lib/node_modules/@deepseek-ai/dsh');
const evidence = join(process.cwd(), 'build/evidence/ASH-005');
const cooperative = process.argv.includes('--cooperative');
mkdirSync(evidence, { recursive: true });
const stamp = () => performance.now();
let requests = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    if (!req.url?.endsWith('/messages')) return void res.writeHead(404).end('{}');
    const p = JSON.parse(body || '{}');
    const tool = (p.tools ?? []).find((t: { name: string }) => t.name === 'lab__wait');
    const useTool = !!tool && requests++ === 0;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_probe', type: 'message', role: 'assistant', model: p.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (useTool) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name: 'lab__wait', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'late model step' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
    }
    ev('message_stop', {});
    res.end();
  });
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockPort = (mock.address() as { port: number }).port;
const dir = mkdtempSync(join(tmpdir(), 'ash-v5-'));
let release!: () => void;
let entered!: () => void;
const enteredPromise = new Promise<void>(resolve => entered = resolve);
const releasePromise = new Promise<void>(resolve => release = resolve);
const record: Record<string, unknown> = { dsh_root: root, fixture: cooperative ? 'in-memory delayed device; resolves on abort' : 'in-memory delayed device; ignores abort to expose late-result behavior' };
let run: Awaited<ReturnType<typeof startOwner>> | undefined;
try {
  run = await startOwner({
    space: 'probe', owner: 'Tester', listen: '127.0.0.1:0', stateDir: join(dir, 'state'), workspaces: { home: join(dir, 'home') },
    dsh: { root, home: join(dir, 'dsh-home'), env: { DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'sk-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/anthropic` } },
    agents: [{ id: 'agent:main', name: 'Ash', runtime: 'dsh', grants: ['*'] }], policy: { maxStepsPerTurn: 4 },
  });
  const client = new AshClient(run.url, Object.entries(run.tokens.api).find(([, member]) => member === OWNER)![0]);
  run.core.devices.upsert({ id: 'device:lab', name: 'Lab', kind: 'laptop', online: true, via: 'local', permissions: ['expose_capability'], capabilities: [{ name: 'wait', description: 'wait in fixture', input_schema: { type: 'object', properties: {} } }] }, {
    call: async (_capability, _args, ctx) => {
      record.tool_entered_at_ms = stamp();
      record.signal_at_entry = ctx.signal?.aborted ?? null;
      ctx.signal?.addEventListener('abort', () => { record.signal_aborted_at_ms = stamp(); if (cooperative) release(); }, { once: true });
      entered();
      await releasePromise;
      record.tool_returned_at_ms = stamp();
      return { ok: true, content: [{ type: 'text', text: 'late fixture result' }] };
    },
  });
  const before = (await client.events({ limit: 1000 })).events.at(-1)?.seq ?? 0;
  await client.deliver('agent:main', { text: 'Use the Lab wait capability.' });
  await Promise.race([enteredPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('tool never entered')), 15000))]);
  record.cancel_at_ms = stamp();
  record.cancel_response = await client.cancel('agent:main');
  const deadline = Date.now() + 5000;
  let ended;
  while (Date.now() < deadline) {
    ended = (await client.events({ after: before, limit: 1000 })).events.find(e => e.type === 'agent.turn.ended');
    if (ended) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  record.turn_end_at_ms = ended ? stamp() : null;
  record.turn_end_reason = ended?.data.reason ?? null;
  record.cancel_to_turn_end_ms = ended ? Number(record.turn_end_at_ms) - Number(record.cancel_at_ms) : null;
  record.tool_still_in_flight_at_turn_end = !!ended && record.tool_returned_at_ms === undefined;
  release();
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = (await client.events({ after: before, limit: 1000 })).events;
  record.events = after.filter(e => ['agent.tool.call', 'agent.tool.result', 'agent.turn.ended', 'agent.text'].includes(e.type)).map(e => ({ type: e.type, data: e.data }));
  record.pass = cooperative ? !!ended && Number(record.cancel_to_turn_end_ms) < 1000 && record.signal_aborted_at_ms !== undefined : !ended && record.signal_aborted_at_ms !== undefined;
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
  record.pass = false;
} finally {
  release?.();
  await run?.close();
  mock.close();
  writeFileSync(join(evidence, cooperative ? 'cooperative.json' : 'abort-ignoring.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ pass: record.pass, cancel_to_turn_end_ms: record.cancel_to_turn_end_ms, tool_still_in_flight_at_turn_end: record.tool_still_in_flight_at_turn_end, error: record.error }));
}
if (!record.pass) process.exitCode = 1;

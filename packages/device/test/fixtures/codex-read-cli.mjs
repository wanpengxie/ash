import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode = 'normal', log, cwd = '/approved'] = process.argv.slice(2);
let reads = 0;
let epoch = 0;
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(frame) + '\n');
  const { id, method, params = {} } = frame;
  if (!['initialize', 'initialized', 'thread/list', 'thread/read', 'thread/turns/list'].includes(method)) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'WRITE METHOD FORBIDDEN' } }) + '\n');
    continue;
  }
  if (method === 'initialized') continue;
  if (method === 'initialize') { send(id, { userAgent: 'fixture' }); continue; }
  if (mode === 'timeout') continue;
  if (mode === 'exit-with-child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (log) appendFileSync(log, JSON.stringify({ fixtureChildPid: child.pid }) + '\n');
    child.unref();
    process.exit(0);
  }
  if (mode === 'invalid-cursor' || mode === 'expired-cursor') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: mode === 'invalid-cursor' ? -32602 : -32000, message: mode === 'invalid-cursor' ? 'Cursor cannot be used' : 'Cursor has expired' } }) + '\n'); continue;
  }
  if (mode === 'unsupported') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue;
  }
  if (mode === 'diagnostic') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'authorization: Bearer fixture-secret' } }) + '\n'); continue;
  }
  if (method === 'thread/read') {
    send(id, { thread: { id: params.threadId, cwd: params.threadId === 'outside' ? '/private' : cwd, status: { type: 'notLoaded' } } }); continue;
  }
  if (method === 'thread/list') {
    const thread = (name, path = cwd, id = 'work-1') => ({ id, cwd: path, name, updatedAt: 172800, status: { type: 'notLoaded' } });
    if (mode === 'oversize') { send(id, { data: [thread('x'.repeat(1024 * 1024))], nextCursor: null }); continue; }
    if (mode === 'envelope-oversize') { send(id, { data: [thread('x'.repeat(1024 * 1024 - 250))], nextCursor: null }); continue; }
    if (mode === 'loop') { send(id, { data: [], nextCursor: params.cursor === 'cursor-a' ? 'cursor-b' : 'cursor-a' }); continue; }
    if (mode === 'long-cycle' || mode === 'long-chain') {
      const index = params.cursor === undefined ? 0 : Number(params.cursor.slice('cursor-'.length));
      const next = mode === 'long-cycle' ? (index + 1) % 130 : index + 1;
      send(id, { data: [], nextCursor: `cursor-${next}` }); continue;
    }
    if (mode === 'refresh' || mode === 'refresh-overlap') {
      if (params.cursor === undefined) epoch++;
      const nextCursor = epoch === 1 ? (params.cursor === undefined ? 'cursor-a' : params.cursor === 'cursor-a' ? 'cursor-b' : null) : (params.cursor === undefined ? 'cursor-b' : params.cursor === 'cursor-b' ? 'cursor-a' : null);
      if (mode === 'refresh-overlap' && epoch === 1 && params.cursor === 'cursor-a') { setTimeout(() => send(id, { data: [], nextCursor }), 80); continue; }
      send(id, { data: [], nextCursor }); continue;
    }
    if (params.cursor) send(id, { data: [thread('new title'), thread('second', cwd, 'work-2')], nextCursor: null });
    else send(id, { data: [thread('old title'), thread('updated title'), thread('private title', '/private', 'outside')], nextCursor: 'opaque/+==' });
    continue;
  }
  reads++;
  if (mode === 'materials') {
    const items = [
      { type: 'userMessage', id: 'u1', clientId: 'native-client-1', content: [
        { type: 'text', text: 'question' },
        { type: 'image', url: 'https://fixture.invalid/private-url-secret' },
        { type: 'image' },
        { type: 'localImage', path: '/private/local-image-secret' },
        { type: 'audio', url: 'https://fixture.invalid/private-audio-secret' },
        { type: 'localAudio', path: '/private/local-audio-secret' },
        { type: 'skill', name: 'private-skill-name', path: '/private/skill-path-secret' },
        { type: 'mention', name: 'private-mention-name', path: '/private/mention-path-secret' },
        { type: 'unknownAttachment', path: '/private/unknown-secret' },
        { type: 'image', fileId: 'private-file-id-secret' },
        { type: 'mention', path: '/private/missing-name-secret' },
        { type: 'localImage', path: 123 },
      ] },
      { type: 'userMessage', id: 'u2', clientId: 'authorization: Bearer fixture-secret', content: [{ type: 'image', fileId: 'private-file-id-secret' }] },
      { type: 'userMessage', id: 'u3', clientId: 'invalid\nclient', content: [{ type: 'text', text: 'question' }] },
      { type: 'agentMessage', id: 'a1', clientId: 'assistant-not-client', text: 'reply' },
    ];
    send(id, { data: [{ id: 'turn-1', items, itemsView: 'full', status: 'completed' }], nextCursor: null }); continue;
  }
  if (mode === 'output-oversize') {
    const items = Array.from({ length: 4000 }, (_, n) => ({ type: 'agentMessage', id: `a${n}`, text: 'x'.repeat(100) }));
    send(id, { data: [{ id: 'turn-1', items, itemsView: 'full', status: 'completed' }], nextCursor: null }); continue;
  }
  const items = [
    { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }, { type: 'image', url: 'private-image' }] },
    { type: 'reasoning', id: 'r1', summary: ['private reasoning'] },
    { type: 'agentMessage', id: 'a1', text: reads === 1 ? 'partial' : 'completed authorization: Bearer fixture-secret', phase: 'final' },
    { type: 'commandExecution', id: 'c1', command: 'private command' },
  ];
  send(id, { data: [{ id: params.cursor ? 'older' : 'turn-1', items, itemsView: mode === 'summary' ? 'summary' : 'full', status: 'interrupted' }], nextCursor: params.cursor ? null : 'older-cursor', backwardsCursor: null });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { THREAD, listenerEpoch } from './codex-gui-steer-probe.mjs';

// One explicitly authorized native diagnostic turn in the existing isolated chat.
// This never counts as the GUI-started C2 test. No steer, interrupt or new thread.
const PID = '76675';
const socket = path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock');
const executable = '/Users/ahaha/.codex/packages/app-server-daemon/releases/local-9779fb5d33dac7766edb79e620bddd2843dd09b6e357e92776d77d9aeca16001-aarch64-apple-darwin/CodexCLI.app/Contents/MacOS/codex';
const runId = randomUUID(), clientId = `diag-${runId}-${randomUUID()}`, base = `DIAG-BASE-${runId}`;
const began = Date.now(), events = [], samples = [], clients = [];
const dir = path.resolve('build/research/daemon-switch/gui-c2');
fs.mkdirSync(dir, { recursive: true });
const output = path.join(dir, `native-history-diagnostic-${runId}.jsonl`), fd = fs.openSync(output, 'wx', 0o600);
let turnId, liveCommand, toolEnded = false, completed = false, finalMarker = false, startCalls = 0;
let fault, sampleTimer, deadlineTimer, sampling = false, observer, settle;
const ended = new Promise(resolve => { settle = resolve; });
const safeId = value => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
const textOf = item => (Array.isArray(item.content) ? item.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
const write = data => { fs.writeSync(fd, JSON.stringify(data) + '\n'); };
const report = data => { write(data); console.log(JSON.stringify(data)); };
const fail = reason => { fault ??= reason; settle(); };
function verify() {
  const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 1000000 };
  const listeners = execFileSync('lsof', ['-nP', '-a', '-p', PID, '-U', '-Fn'], options).split('\n');
  const txt = execFileSync('lsof', ['-a', '-p', PID, '-d', 'txt', '-Fn'], options).split('\n');
  return listenerEpoch(socket, PID, listeners, txt, executable);
}
const epoch = verify();
const bundleVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];

async function connection(name, canStart) {
  const ws = new WebSocket(`ws+unix://localhost${socket}:/rpc`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024, perMessageDeflate: false });
  let id = 0, closed = false;
  const pending = new Map();
  const cleanup = reason => { for (const q of pending.values()) { clearTimeout(q.timer); q.reject(new Error(reason)); } pending.clear(); };
  const client = {
    rpc(method, params) {
      if (!['initialize', 'thread/read', 'thread/turns/list', 'thread/resume', ...(canStart ? ['turn/start'] : [])].includes(method)) throw new Error('forbidden_method');
      if (method !== 'initialize' && params.threadId !== THREAD) throw new Error('wrong_thread');
      if (method === 'thread/resume' && (params.excludeTurns !== true || Object.keys(params).some(k => !['threadId', 'excludeTurns'].includes(k)))) throw new Error('unsafe_resume');
      if (method === 'turn/start' && (startCalls !== 1 || params.clientUserMessageId !== clientId)) throw new Error('duplicate_or_wrong_start');
      if (closed) return Promise.reject(new Error('disconnect'));
      return new Promise((resolve, reject) => {
        const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error('rpc_timeout')); }, 5000);
        pending.set(requestId, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id: requestId, method, params })); } catch { clearTimeout(timer); pending.delete(requestId); reject(new Error('disconnect')); }
      });
    },
    close() { closed = true; cleanup('closed'); ws.close(); },
  };
  clients.push(client);
  ws.on('message', bytes => {
    if (Buffer.byteLength(bytes) > 1024 * 1024) { fail('oversize'); return; }
    let m; try { m = JSON.parse(bytes.toString()); } catch { fail('invalid_json'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { fail('invalid_json'); return; }
    const q = pending.get(m.id);
    if (q && !m.method) { clearTimeout(q.timer); pending.delete(m.id); m.error ? q.reject(new Error('rpc_error')) : q.resolve(m.result); return; }
    if (m.params?.threadId !== THREAD) return;
    if (m.id !== undefined && m.method) { report({ state: 'approval_requires_user', ms: Date.now() - began }); fail('approval_or_server_request'); return; }
    if (name !== 'ash_native_history_observer') return;
    const p = m.params;
    if (events.length < 2000) events.push({ ms: Date.now() - began, method: typeof m.method === 'string' && /^[\w/:-]{1,128}$/.test(m.method) ? m.method : undefined,
      threadId: THREAD, turnId: safeId(p.turn?.id ?? p.turnId), itemId: safeId(p.item?.id), itemType: safeId(p.item?.type), status: safeId(p.item?.status ?? p.turn?.status ?? p.status?.type) });
    if (/approval|requestPermissions/i.test(m.method ?? '') || p.status?.activeFlags?.includes('waitingOnApproval')) { fail('approval'); return; }
    const eventTurn = p.turn?.id ?? p.turnId;
    if (!turnId && m.method === 'turn/started' && startCalls === 1) turnId = eventTurn;
    if (!turnId || eventTurn !== turnId) return;
    if (m.method === 'item/started' && p.item?.type === 'commandExecution') {
      if (liveCommand && liveCommand.id !== p.item.id) { fail('multiple_commands'); return; }
      liveCommand = { id: p.item.id, command: p.item.command, started: Date.now(), status: p.item.status };
      report({ state: 'live_command_started', ms: Date.now() - began, turnId, itemId: safeId(p.item.id), status: safeId(p.item.status) });
    }
    if (m.method === 'item/completed' && p.item?.type === 'commandExecution' && p.item.id === liveCommand?.id) {
      toolEnded = true; liveCommand.exitCode = p.item.exitCode; liveCommand.status = p.item.status;
      report({ state: 'live_command_completed', ms: Date.now() - began, turnId, itemId: safeId(p.item.id), status: safeId(p.item.status), exitCode: p.item.exitCode });
    }
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'final_answer') finalMarker = typeof p.item.text === 'string' && p.item.text.includes(base);
    if (m.method === 'turn/completed') { completed = true; report({ state: 'turn_completed', ms: Date.now() - began, turnId, status: safeId(p.turn?.status) }); settle(); }
  });
  ws.on('close', () => { if (!closed) { closed = true; cleanup('disconnect'); fail('disconnect'); } });
  ws.on('error', () => { cleanup('disconnect'); fail('disconnect'); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('disconnect'))); });
  const init = await client.rpc('initialize', { clientInfo: { name, version: '0.0.0' }, capabilities: { experimentalApi: true } });
  const serverVersion = init.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  if (!bundleVersion || serverVersion !== bundleVersion || verify() !== epoch) throw new Error('version_or_epoch_mismatch');
  ws.send(JSON.stringify({ method: 'initialized' }));
  return client;
}
try {
  const starter = await connection('ash_native_history_starter', true);
  observer = await connection('ash_native_history_observer', false);
  for (const client of [starter, observer]) {
    const metadata = await client.rpc('thread/read', { threadId: THREAD, includeTurns: false });
    if (metadata.thread?.id !== THREAD || metadata.thread?.status?.type !== 'idle') throw new Error('target_not_idle');
    const baseline = await client.rpc('thread/turns/list', { threadId: THREAD, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    if (!Array.isArray(baseline.data) || baseline.data.some(t => t.status === 'inProgress')) throw new Error('baseline_not_idle');
    const subscribed = await client.rpc('thread/resume', { threadId: THREAD, excludeTurns: true });
    if (subscribed.thread?.id !== THREAD || subscribed.thread?.status?.type !== 'idle') throw new Error('target_not_idle');
  }
  const last = await starter.rpc('thread/read', { threadId: THREAD, includeTurns: false });
  if (last.thread?.id !== THREAD || last.thread.status?.type !== 'idle' || verify() !== epoch || fault) throw new Error('prestart_not_idle_or_epoch');
  startCalls = 1;
  report({ state: 'start_intent', ms: Date.now() - began, runId, threadId: THREAD, clientId, startCalls, bundleVersion }); fs.fsyncSync(fd);
  deadlineTimer = setTimeout(() => fail('deadline'), 600000);
  const started = await starter.rpc('turn/start', { threadId: THREAD, clientUserMessageId: clientId, input: [{ type: 'text', text: `这是隔离原生 history 映射诊断 ${runId}。初始标记 ${base}。仅执行一次 sleep 25。不要读写项目文件，不要调用其他工具，不要启动子 Agent。等待正常结束后只回复 ${base}。`, text_elements: [] }] });
  if (!started.turn?.id || turnId && started.turn.id !== turnId) throw new Error('start_turn_mismatch');
  turnId = started.turn.id;
  report({ state: 'start_ack', ms: Date.now() - began, turnId });
  sampleTimer = setInterval(async () => {
    if (sampling || !liveCommand || toolEnded || completed || fault || samples.length >= 12) return;
    sampling = true;
    try {
      if (verify() !== epoch) throw new Error('epoch_changed');
      const native = await observer.rpc('thread/read', { threadId: THREAD, includeTurns: false });
      if (native.thread?.id !== THREAD) throw new Error('wrong_thread');
      const history = await observer.rpc('thread/turns/list', { threadId: THREAD, limit: 25, sortDirection: 'desc', itemsView: 'full' });
      const t = (history.data ?? []).find(t => t.id === turnId), items = Array.isArray(t?.items) ? t.items : [], commands = items.filter(i => i.type === 'commandExecution');
      const record = { state: 'sample', sample: samples.length + 1, ms: Date.now() - began, threadId: THREAD, turnId,
        nativeStatus: safeId(native.thread.status?.type), activeFlags: (Array.isArray(native.thread.status?.activeFlags) ? native.thread.status.activeFlags : []).map(safeId).filter(Boolean),
        turnPresent: Boolean(t), turnStatus: safeId(t?.status), baseCount: items.filter(i => i.type === 'userMessage' && textOf(i).includes(base)).length,
        commandCount: commands.length, commands: commands.slice(0, 8).map(c => ({ id: safeId(c.id), idMatch: c.id === liveCommand.id, commandMatch: c.command === liveCommand.command, status: safeId(c.status) })),
        itemTypes: [...new Set(items.map(i => safeId(i.type)).filter(Boolean))].slice(0, 16), liveToolEndedAtRead: toolEnded };
      samples.push(record); report(record);
    } catch (e) { fail(['epoch_changed', 'rpc_timeout', 'wrong_thread'].includes(e.message) ? e.message : 'sampling_error'); }
    finally { sampling = false; }
  }, 500);
  await ended;
} catch (e) { fault ??= ['target_not_idle', 'baseline_not_idle', 'version_or_epoch_mismatch', 'prestart_not_idle_or_epoch', 'rpc_timeout', 'start_turn_mismatch'].includes(e.message) ? e.message : 'setup_or_rpc_error'; }
finally {
  clearInterval(sampleTimer); clearTimeout(deadlineTimer);
  for (const client of clients) client.close();
  write({ state: 'events', events });
  report({ state: 'result', output, runId, threadId: THREAD, turnId, clientId, startCalls, steerCalls: 0, interruptCalls: 0,
    completed, finalMarker, toolEnded, exitCode: liveCommand?.exitCode, sampleCount: samples.length, reason: fault ?? null, result: completed && toolEnded && !fault ? 'diagnostic_complete' : startCalls ? 'unknown' : 'inconclusive', guiC2Pass: false });
  fs.closeSync(fd);
}

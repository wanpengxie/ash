import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const THREAD = '01a11f8f-7ff8-7ab2-9ad7-0607832213a9';
export function parseObserveMs(value) {
  if (value === undefined) return 600000;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1000 || Number(value) > 600000) throw new Error('invalid_observe_ms');
  return Number(value);
}
const evidenceId = value => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
export function listenerEpoch(socket, pid, listenerLines, executableLines, executable) {
  const canonical = fs.realpathSync(socket), s = fs.statSync(socket);
  if (!s.isSocket() || !listenerLines.includes(`n${canonical}`)) throw new Error('listener_owner_mismatch');
  if (!executableLines.includes(`n${fs.realpathSync(executable)}`)) throw new Error('bundle_executable_mismatch');
  return `${canonical}:${s.dev}:${s.ino}:${pid}`;
}
const active = t => t?.status === 'inProgress';
const waitCommand = command => ['sleep 25', '/bin/zsh -lc "sleep 25"', "/bin/zsh -lc 'sleep 25'", '/bin/bash -lc "sleep 25"', "/bin/bash -lc 'sleep 25'"].includes(command);
const textOf = i => (Array.isArray(i.content) ? i.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
export function guiInput(runId) {
  return `这是 Ash GUI 发起对照 ${runId}。初始标记 GUI-BASE-${runId}。只执行一次 sleep 25，不要读写项目文件或调用其他工具，不要启动子 Agent。等待结束后仅回复 GUI-BASE-${runId}；若收到本轮补充标记，将它附在同一条最终回复。`;
}

// Pure, fail-closed state machine. No RPC, content logging, or timers.
export class Probe {
  constructor({ runId = randomUUID(), baseline = [], now = Date.now(), armMs = 180000, observeMs = 600000 } = {}) {
    this.runId = runId; this.clientId = `gui-${runId}-${randomUUID()}`;
    this.base = `GUI-BASE-${runId}`; this.append = `GUI-APPEND-${runId}`;
    this.baseline = new Set(baseline); this.turns = new Map(); this.armDeadline = now + armMs;
    this.observeMs = observeMs; this.deadline = this.armDeadline; this.sent = false;
    this.reason = null; this.ack = false; this.done = false; this.calls = 0; this.historyItemId = null;
    this.began = now; this.evidence = []; this.droppedEvents = 0;
    this.preflightChecks = []; this.preflightAttempts = 0; this.nextPreflightAt = 0;
  }
  stop(reason) { this.reason ??= reason; }
  event(m, now = Date.now()) {
    if (m.params?.threadId !== THREAD) return;
    if (this.evidence.length < 2000) {
      const p = m.params;
      this.evidence.push({ ms: Math.max(0, now - this.began), method: typeof m.method === 'string' && /^[\w/:-]{1,128}$/.test(m.method) ? m.method : undefined, threadId: THREAD,
        turnId: evidenceId(p.turn?.id ?? p.turnId), itemType: evidenceId(p.item?.type), itemId: evidenceId(p.item?.id), status: evidenceId(p.item?.status ?? p.turn?.status ?? p.status?.type) });
    } else this.droppedEvents++;
    if (m.id !== undefined && m.method) { this.stop('approval_or_server_request'); return; }
    if (/approval|requestPermissions/i.test(m.method ?? '')) { this.stop('approval'); return; }
    if (m.method === 'thread/status/changed' && Array.isArray(m.params.status?.activeFlags) && m.params.status.activeFlags.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag))) { this.stop('approval_or_user_input_pending'); return; }
    if (now >= this.deadline) { this.stop('deadline'); return; }
    const p = m.params; const id = p.turn?.id ?? p.turnId;
    if (!id || this.baseline.has(id)) return;
    if (m.method === 'turn/started') {
      if (!this.turns.has(id)) {
        this.turns.set(id, { id, active: active(p.turn), users: new Map(), commands: new Map(), final: false });
        this.deadline = Math.min(now + this.observeMs, this.armDeadline + this.observeMs);
      }
      if (this.turns.size > 1) this.stop('multiple_new_turns');
      return;
    }
    const t = this.turns.get(id); if (!t) return;
    if (m.method === 'turn/completed') { t.active = false; t.status = p.turn?.status; this.done = true; return; }
    if (!['item/started', 'item/completed'].includes(m.method)) return;
    const i = p.item; if (!i?.id) { this.stop('invalid_item'); return; }
    if (i.type === 'userMessage') t.users.set(i.id, textOf(i).includes(this.base));
    else if (i.type === 'commandExecution') {
      if (!waitCommand(i.command)) { this.stop('unexpected_command'); return; }
      const prior = t.commands.get(i.id);
      if (m.method === 'item/started' && prior?.ended) { this.stop('command_restarted'); return; }
      if (prior && prior.command !== i.command) { this.stop('command_changed'); return; }
      t.commands.set(i.id, { command: i.command, started: prior?.started || m.method === 'item/started', ended: prior?.ended || m.method === 'item/completed', exitCode: i.exitCode ?? prior?.exitCode, status: i.status });
      if (t.commands.size > 1) this.stop('multiple_commands');
    } else if (i.type === 'agentMessage') {
      if (m.method === 'item/completed' && i.phase === 'final_answer') t.final = typeof i.text === 'string' && i.text.includes(this.base) && i.text.includes(this.append);
    } else if (i.type !== 'reasoning') this.stop('unexpected_tool_or_item');
  }
  candidate(now = Date.now()) {
    if (this.reason || this.sent || now >= this.deadline || this.turns.size !== 1) return false;
    const t = [...this.turns.values()][0], cs = [...t.commands.values()];
    return t.active && cs.length === 1 && cs[0].started && !cs[0].ended && cs[0].status === 'inProgress';
  }
  eligible(now = Date.now()) {
    return this.candidate(now) && [...[...this.turns.values()][0].users.values()].filter(Boolean).length === 1;
  }
  preflight(turns, now = Date.now()) {
    if (!this.candidate(now)) return 'stop';
    const fresh = turns.filter(t => !this.baseline.has(t.id)), t = fresh.find(t => t.id === [...this.turns.keys()][0]);
    const items = Array.isArray(t?.items) ? t.items : [], commands = items.filter(i => i.type === 'commandExecution');
    const live = [...this.turns.values()][0].commands.values().next().value;
    const baseCount = items.filter(i => i.type === 'userMessage' && textOf(i).includes(this.base)).length;
    const types = [...new Set(items.map(i => ['commandExecution', 'userMessage', 'agentMessage', 'reasoning'].includes(i.type) ? i.type : 'unexpected'))];
    const detail = { ms: Math.max(0, now - this.began), attempt: ++this.preflightAttempts, newTurnCount: fresh.length, turnIdMatch: Boolean(t),
      turnStatus: evidenceId(t?.status), commandCount: commands.length, commandIdMatch: commands.length === 1 && commands[0].id === [...this.turns.values()][0].commands.keys().next().value,
      commandMatch: commands.length === 1 && commands[0].command === live.command, commandStatus: evidenceId(commands[0]?.status), baseCount, itemTypes: types, toolSource: 'native_live_event' };
    let decision = 'ready';
    if (fresh.length > 1 || fresh.some(turn => turn.id !== [...this.turns.keys()][0]) || commands.length > 1 || baseCount > 1 || types.includes('unexpected')) { this.stop('history_ambiguous_or_unexpected'); decision = 'stop'; }
    else if (commands.length === 1 && (!detail.commandIdMatch || !detail.commandMatch || ['completed', 'failed', 'declined'].includes(commands[0].status))) { this.stop('history_command_conflict_or_ended'); decision = 'stop'; }
    else if (t && ['completed', 'interrupted', 'failed'].includes(t.status)) { this.stop('history_turn_ended'); decision = 'stop'; }
    // This daemon exposes persisted history: zero stored commands during a live wait is normal.
    // candidate() above requires the unique native started event, still active and uncompleted.
    else if (!t || !active(t) || commands.length === 1 && commands[0].status !== 'inProgress' || baseCount !== 1) decision = 'retry';
    if (decision === 'retry') {
      this.nextPreflightAt = now + 500;
      if (this.preflightAttempts >= 8) { this.stop('history_not_hydrated_after_bounded_retry'); decision = 'stop'; }
    }
    detail.decision = decision;
    if (this.preflightChecks.length < 32) this.preflightChecks.push(detail);
    if (decision === 'ready') for (const item of items) if (item.type === 'userMessage') this.event({ method: 'item/completed', params: { threadId: THREAD, turnId: t.id, item } }, now);
    return decision;
  }
  intent(now = Date.now()) {
    if (!this.eligible(now)) return null;
    this.sent = true; this.calls++;
    return { threadId: THREAD, expectedTurnId: [...this.turns.keys()][0], clientUserMessageId: this.clientId,
      input: [{ type: 'text', text: `本轮补充标记 ${this.append}。把它附在同一条最终回复；继续当前等待，不要中断或重复工具。`, text_elements: [] }] };
  }
  receipt(r) { if (r?.turnId !== [...this.turns.keys()][0]) this.stop('ack_turn_mismatch'); else this.ack = true; }
  history(turns) {
    const uniqueTurns = [...new Map(turns.map(t => [t.id, t])).values()];
    const hits = uniqueTurns.flatMap(t => (t.items ?? []).filter(i => i.type === 'userMessage' && i.clientId === this.clientId).map(i => ({ turnId: t.id, itemId: i.id })));
    if (hits.length !== 1 || hits[0].turnId !== [...this.turns.keys()][0] || !hits[0].itemId) return false;
    this.historyItemId = hits[0].itemId;
    const t = uniqueTurns.find(t => t.id === hits[0].turnId), items = t.items ?? [], commands = items.filter(i => i.type === 'commandExecution');
    const final = items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer').at(-1);
    this.historyVerified = t.status === 'completed' && commands.length === 1 && commands[0].id === [...this.turns.values()][0].commands.keys().next().value
      && commands[0].command === [...this.turns.values()][0].commands.values().next().value.command && commands[0].status === 'completed' && commands[0].exitCode === 0
      && items.filter(i => i.type === 'userMessage' && textOf(i).includes(this.base)).length === 1
      && typeof final?.text === 'string' && final.text.includes(this.base) && final.text.includes(this.append)
      && items.every(i => ['commandExecution', 'userMessage', 'agentMessage', 'reasoning'].includes(i.type));
    return true;
  }
  result() {
    const t = [...this.turns.values()][0], c = t && [...t.commands.values()][0];
    const pass = !this.reason && this.sent && this.ack && this.done && t?.status === 'completed' && c?.ended && c.exitCode === 0 && c.status === 'completed' && t.final && this.historyItemId && this.historyVerified;
    return { result: pass ? 'pass' : this.sent && (!this.ack || !this.historyItemId || this.reason === 'disconnect' || this.reason === 'rpc_timeout') ? 'unknown' : 'inconclusive', reason: this.reason,
      runId: this.runId, threadId: THREAD, turnId: t?.id, commandItemId: t && [...t.commands.keys()][0], clientId: this.clientId,
      historyItemId: this.historyItemId, historyVerified: this.historyVerified ?? false, steerCalls: this.calls, ackSameTurn: this.ack, completed: this.done, finalMarkers: t?.final ?? false, exitCode: c?.exitCode,
      eventCount: this.evidence.length, droppedEvents: this.droppedEvents, observeMs: this.observeMs };
  }
}

export class Rpc {
  constructor(ws, onEvent, onFault, timeout = 5000) {
    this.ws = ws; this.pending = new Map(); this.id = 0; this.timeout = timeout; this.closed = false;
    ws.on('message', bytes => {
      if (Buffer.byteLength(bytes) > 1024 * 1024) return this.fail('oversize', onFault);
      let m; try { m = JSON.parse(bytes.toString()); } catch { return this.fail('invalid_json', onFault); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return this.fail('invalid_json', onFault);
      const q = this.pending.get(m.id);
      if (q && !m.method) { clearTimeout(q.timer); this.pending.delete(m.id); m.error ? q.reject(new Error('rpc_error')) : q.resolve(m.result); }
      else if (m.method) onEvent(m); // Duplicate responses never become events.
    });
    ws.on('close', () => this.fail('disconnect', onFault)); ws.on('error', () => this.fail('disconnect', onFault));
  }
  fail(reason, onFault) { if (this.closed) return; this.closed = true; onFault(reason); this.cleanup(reason); this.ws.close(); }
  cleanup(reason = 'closed') { for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(new Error(reason)); } this.pending.clear(); }
  request(method, params) {
    if (!['initialize', 'thread/read', 'thread/turns/list', 'thread/resume', 'turn/steer'].includes(method)) throw new Error('forbidden_method');
    if (method !== 'initialize' && params.threadId !== THREAD) throw new Error('wrong_thread');
    if (method === 'thread/resume' && (params.excludeTurns !== true || Object.keys(params).some(k => !['threadId', 'excludeTurns'].includes(k)))) throw new Error('unsafe_resume');
    if (this.closed) return Promise.reject(new Error('disconnect'));
    return new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('rpc_timeout')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('disconnect')); }
    });
  }
  close() { this.closed = true; this.cleanup(); this.ws.close(); }
}

// CLI deliberately requires explicit same-bundle listener evidence. No TCP fallback.
async function main() {
  const argv = process.argv.slice(2), opts = {};
  for (let i = 0; i < argv.length; i += 2) { if (!/^--(socket|pid|executable|out-dir|observe-ms)$/.test(argv[i]) || !argv[i + 1]) throw new Error('invalid_arguments'); opts[argv[i].slice(2)] = argv[i + 1]; }
  const observeMs = parseObserveMs(opts['observe-ms']);
  for (const key of ['socket', 'pid', 'executable', 'out-dir']) if (!opts[key]) throw new Error(`missing_${key}`);
  if (!path.isAbsolute(opts.socket) || /[:?#]/.test(opts.socket) || !fs.statSync(opts.socket).isSocket() || !/^\d+$/.test(opts.pid) || !path.isAbsolute(opts.executable)) throw new Error('invalid_unix_listener');
  const verify = () => {
    const lines = execFileSync('lsof', ['-nP', '-a', '-p', opts.pid, '-U', '-Fn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1000000 }).split('\n');
    const executable = execFileSync('lsof', ['-a', '-p', opts.pid, '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1000000 }).split('\n');
    return listenerEpoch(opts.socket, opts.pid, lines, executable, opts.executable);
  };
  const epoch = verify(), probe = new Probe({ observeMs }); let rpc, armed = false, busy = false, timer, settle, serverVersion;
  const bundleVersion = execFileSync(opts.executable, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).trim();
  const version = bundleVersion.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  if (!version) throw new Error('bundle_version_missing');
  const ended = new Promise(r => { settle = r; });
  fs.mkdirSync(opts['out-dir'], { recursive: true });
  const output = path.join(opts['out-dir'], `gui-steer-${probe.runId}.jsonl`);
  const fd = fs.openSync(output, 'wx', 0o600); // Reserve before connecting; never overwrite.
  try {
    const ws = new WebSocket(`ws+unix://localhost${opts.socket}:/rpc`, { handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    rpc = new Rpc(ws, m => { if (armed) probe.event(m); else if (m.params?.threadId === THREAD && m.method === 'turn/started') probe.stop('activity_during_baseline'); }, reason => { probe.stop(reason); settle(); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('disconnect'))); });
    const init = await rpc.request('initialize', { clientInfo: { name: 'ash_gui_observer', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    serverVersion = init.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (serverVersion !== version || verify() !== epoch) throw new Error('version_or_epoch_mismatch');
    ws.send(JSON.stringify({ method: 'initialized' }));
    const metadata = await rpc.request('thread/read', { threadId: THREAD, includeTurns: false });
    if (metadata.thread?.id !== THREAD || metadata.thread?.status?.type !== 'idle') throw new Error('target_not_idle');
    const baseline = await rpc.request('thread/turns/list', { threadId: THREAD, limit: 25, sortDirection: 'desc', itemsView: 'full' });
    if (!Array.isArray(baseline.data) || baseline.data.some(active) || probe.reason) throw new Error('baseline_not_idle');
    // Authorized only for this isolated test chat, as a subscription with no overrides.
    const subscription = await rpc.request('thread/resume', { threadId: THREAD, excludeTurns: true });
    if (subscription.thread?.id !== THREAD || subscription.thread?.status?.type !== 'idle' || probe.reason) throw new Error('baseline_not_idle');
    probe.baseline = new Set(baseline.data.map(t => t.id)); armed = true; probe.began = Date.now(); probe.armDeadline = probe.began + 180000; probe.deadline = probe.armDeadline;
    console.log(JSON.stringify({ state: 'ARMED', threadId: THREAD, runId: probe.runId, input: guiInput(probe.runId), armMs: 180000, observeMs, observation: 'fixed_test_thread_subscription' }));
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        if (Date.now() >= probe.deadline) { probe.stop('deadline'); settle(); return; }
        if (probe.done || probe.reason) { settle(); return; }
        if (!probe.candidate() || Date.now() < probe.nextPreflightAt) return;
        if (verify() !== epoch) { probe.stop('epoch_changed'); settle(); return; }
        const live = await rpc.request('thread/read', { threadId: THREAD, includeTurns: false });
        if (live.thread?.id !== THREAD || live.thread?.status?.type !== 'active' || !Array.isArray(live.thread.status.activeFlags) || live.thread.status.activeFlags.length) { probe.stop('live_not_active_or_pending_approval'); return; }
        const current = await rpc.request('thread/turns/list', { threadId: THREAD, limit: 25, sortDirection: 'desc', itemsView: 'full' });
        if (!Array.isArray(current.data)) { probe.stop('invalid_history_response'); return; }
        // Persisted history may lag live notifications. Retry only missing data, never conflicts.
        if (probe.preflight(current.data) !== 'ready') return;
        if (verify() !== epoch) { probe.stop('epoch_changed'); settle(); return; }
        const intent = probe.intent(); if (!intent) return;
        fs.writeSync(fd, JSON.stringify({ state: 'intent', ...probe.result() }) + '\n'); fs.fsyncSync(fd);
        probe.receipt(await rpc.request('turn/steer', intent));
      } catch (e) { probe.stop(e.message === 'rpc_timeout' ? 'rpc_timeout' : 'verification_or_rpc_error'); settle(); }
      finally { busy = false; }
    }, 50);
    await ended; clearInterval(timer);
    // No reconnect or resend. A lost receipt remains unknown; later reconciliation is read-only.
    if (!rpc.closed && probe.sent) {
      let cursor; const turns = [];
      for (let page = 0; page < 4; page++) {
        if (verify() !== epoch) { probe.stop('epoch_changed'); break; }
        const r = await rpc.request('thread/turns/list', { threadId: THREAD, limit: 25, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
        turns.push(...(r.data ?? [])); cursor = r.nextCursor; if (!cursor) break;
      }
      probe.history(turns);
    }
  } catch (e) { probe.stop(['target_not_idle', 'baseline_not_idle', 'version_or_epoch_mismatch', 'rpc_timeout'].includes(e.message) ? e.message : 'setup_or_rpc_error'); }
  finally {
    clearInterval(timer); rpc?.close(); fs.writeSync(fd, JSON.stringify({ state: 'result', time: new Date().toISOString(), bundleVersion: version, serverVersion, ...probe.result(), events: probe.evidence, preflightChecks: probe.preflightChecks }) + '\n'); fs.closeSync(fd);
    console.log(JSON.stringify({ output, ...probe.result() }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Probe configuration rejected'); process.exitCode = 1; });

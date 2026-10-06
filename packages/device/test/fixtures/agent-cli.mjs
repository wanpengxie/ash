import readline from 'node:readline';
const kind = process.argv[2];
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const result = (id, result) => emit({ jsonrpc: '2.0', id, result });
const notify = (method, params) => emit({ jsonrpc: '2.0', method, params });
let active, counter = 0, endpoint, options;
const longReply = '完整结果🙂'.repeat(1500);
const finish = interrupted => {
  if (!active) return;
  if (kind === 'codex') notify('turn/completed', { threadId: 'thread-1', turn: { id: active.id, status: interrupted ? 'interrupted' : 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: longReply }] } });
  if (kind === 'claude') emit({ type: 'result', session_id: options.session_id, user_message_uuid: active.id, result: longReply, is_error: false });
  if (kind === 'workbuddy') result(active.rpc, { stopReason: interrupted ? 'cancelled' : 'end_turn' });
  active = undefined;
};
const wbUpdate = update => notify('session/update', { sessionId: 'wb-1', update });

for await (const line of readline.createInterface({ input: process.stdin })) {
  const f = JSON.parse(line), p = f.params ?? {};
  if (f.method === 'crash') process.exit(7);
  if (kind === 'codex') {
    if (f.method === 'initialize') result(f.id, { userAgent: 'fixture' });
    else if (f.method === 'thread/start' || f.method === 'thread/resume') {
      if (p.approvalPolicy !== 'never' || p.sandbox !== 'danger-full-access') throw new Error('wrong runtime configuration');
      if (p.dynamicTools?.some(t => t.type !== 'function')) throw new Error('wrong tool schema');
      result(f.id, { thread: { id: 'thread-1' } });
    } else if (f.method === 'turn/start') {
      active = { id: `native-${++counter}` };
      // Started can arrive before the RPC acceptance response.
      notify('turn/started', { threadId: 'thread-1', turn: { id: active.id } });
      result(f.id, { turn: { id: active.id } });
      notify('item/completed', { threadId: 'wrong-thread', turnId: active.id, item: { id: 'wrong', type: 'agentMessage', text: 'WRONG' } });
      notify('item/completed', { threadId: 'thread-1', turnId: 'old-turn', item: { id: 'late', type: 'agentMessage', text: 'LATE' } });
      notify('item/started', { threadId: 'thread-1', turnId: active.id, item: { id: 'shell', type: 'commandExecution', command: 'echo hello' } });
      if (p.input[0].text === 'crash') process.exit(7);
      emit({ id: 'tool-call', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: active.id, callId: 'call-1', tool: 'agent_list', arguments: {} } });
    } else if (f.method === 'turn/steer') { result(f.id, {}); if (p.input[0].text === 'finish') finish(false); }
    else if (f.method === 'turn/interrupt') { result(f.id, {}); setTimeout(() => finish(true), 40); }
  }
  if (kind === 'claude') {
    if (f.type === 'control_request') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: {} } });
      if (f.request.subtype === 'interrupt') setTimeout(() => finish(true), 40);
    } else if (f.type === 'user') {
      options = f;
      if (active) {
        emit({ type: 'command_lifecycle', command_uuid: f.uuid, state: 'queued' });
        if (f.message.content[0].text === 'finish') finish(false);
      } else {
        active = { id: f.uuid };
        emit({ type: 'command_lifecycle', command_uuid: f.uuid, state: 'started' });
        if (f.message.content[0].text === 'crash') process.exit(7);
        emit({ type: 'assistant', session_id: f.session_id, message: { content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', id: 'shell', name: 'Bash' }] } });
        emit({ type: 'control_request', request_id: 'tool-call', request: { subtype: 'mcp_message', server_name: 'ash', message: { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'agent_list', arguments: {} } } } });
      }
    }
  }
  if (kind === 'workbuddy') {
    if (f.method === 'initialize') result(f.id, { protocolVersion: 1 });
    else if (f.method === 'session/new' || f.method === 'session/load') {
      endpoint = p.mcpServers[0];
      result(f.id, { sessionId: 'wb-1', models: { currentModelId: 'old-model' }, configOptions: [{ id: 'thought_level', currentValue: 'low' }] });
    } else if (f.method === 'session/set_model' || f.method === 'session/set_config_option') result(f.id, {});
    else if (f.method === 'session/prompt') {
      active = { id: `native-${++counter}`, rpc: f.id };
      if (p.prompt[0].text === 'crash') process.exit(7);
      wbUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: longReply + '\n\n' } });
      wbUpdate({ sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'Bash', status: 'in_progress' });
      void fetch(endpoint.url, { method: 'POST', headers: { authorization: endpoint.headers[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'agent_list', arguments: {} } }) }).then(r => r.json()).catch(() => {});
    } else if (f.method === 'session/steer') { result(f.id, { steered: true }); if (p.contentBlocks[0].text === 'finish') finish(false); }
    else if (f.method === 'session/cancel') setTimeout(() => finish(true), 40);
  }
}

// Coworker uses the existing owner human channel. Scope comes from the kernel;
// connectionId is only a stale-response guard, never an owner credential.
export function installCoworkerNet(net) {
  net.endpoint = globalThis.location?.origin || 'local';
  net.currentScope = null;
  Object.defineProperty(net, 'connectionId', { get: () => net.session });
  net.acceptScope = scope => { net.currentScope = typeof scope === 'string' && scope ? scope : null; };
  const call = async (word, body = {}, signal) => {
    const binding = net.binding();
    let result;
    try { result = await net.data('service:collaboration', 'collaboration.' + word, body, { signal }); }
    catch (error) { if (typeof error?.detail?.code === 'string') error.code = error.detail.code; throw error; }
    if (signal?.aborted || !net.same(binding)) throw Object.assign(new Error('连接已改变'), { code: 'permission_denied' });
    return result;
  };
  net.collaborationEndpoints = signal => call('endpoints', {}, signal);
  net.collaborationControlEndpoints = signal => call('control.endpoints', {}, signal);
  net.collaborationCreateEndpoints = signal => call('create.endpoints', {}, signal);
  for (const [method, family, allowed] of [['collaborationControl', 'control', ['state','apply','query','reconcile']], ['collaborationCreate', 'create', ['projects','apply','query','reconcile']]]) {
    net[method] = async (operation, input, signal) => {
      if (!allowed.includes(operation)) throw new Error('unsupported operation');
      const scope = net.currentScope;
      const result = await call(family + '.' + operation, input, signal);
      if (scope !== net.currentScope || result.auth_scope !== scope) throw Object.assign(new Error('授权已改变'), { code: 'permission_denied' });
      return result;
    };
  }
  net.collaborationRead = (target, work, cursor, signal) => call('read', { version: 1, device_id: target.device_id, endpoint_id: target.endpoint_id, authorization_generation: target.authorization_generation, authorization_revision: target.authorization_revision, action: work ? 'read_work' : 'list_work', page: { limit: work ? 10 : 50, ...(cursor ? { cursor } : {}) }, ...(work ? { work } : {}) }, signal);
  net.collaborationResultFile = async (target, work, turn, message, href, cursor, signal) => {
    const scope = net.currentScope;
    const result = await call('result.prepare', { version: 1, device_id: target.device_id, endpoint_id: target.endpoint_id, authorization_generation: target.authorization_generation, authorization_revision: target.authorization_revision, work, turn_id: turn, source_message_id: message, exact_href: href, ...(cursor ? { page_cursor: cursor } : {}) }, signal);
    if (result.auth_scope !== scope) throw Object.assign(new Error('授权已改变'), { code: 'permission_denied' });
    return result.result;
  };
  net.refreshCoworkerScope = async () => {
    const result = await net.collaborationEndpoints();
    net.acceptScope(result.auth_scope);
    return result;
  };
  net.saveCoworkerResult = async ref => {
    const binding = net.binding(), scope = net.currentScope;
    const body = { save_id: ref.save_id, asset_version: ref.asset.version, sha256: ref.asset.sha256 };
    const snap = await call('result.snapshot', body);
    if (snap.auth_scope !== scope) throw Object.assign(new Error('授权已改变'), { code: 'permission_denied' });
    const result = snap.result;
    const stream = await net.stream(result.stream);
    if (!net.same(binding)) throw Object.assign(new Error('连接已改变'), { code: 'permission_denied' });
    const bytes = stream.data;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (bytes.length > 4194304 || bytes.length !== ref.asset.byte_length || digest !== ref.asset.sha256 || result.asset?.sha256 !== ref.asset.sha256 || result.asset?.version !== ref.asset.version) throw Object.assign(new Error('文件校验失败'), { code: 'hash_mismatch' });
    const check = await call('result.check', body);
    if (check.auth_scope !== scope || check.result?.current !== true) throw Object.assign(new Error('授权已改变'), { code: 'permission_denied' });
    const url = URL.createObjectURL(new Blob([bytes], { type: ref.asset.media_type }));
    const a = document.createElement('a'); a.href = url; a.download = ref.asset.display_name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
  };
  return net;
}

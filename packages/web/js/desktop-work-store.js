// Saved-history references are scoped by authentication, permission revision and full work identity.
export const CACHE_LIMITS = Object.freeze({ ttl: 24 * 60 * 60 * 1000, works: 100, messages: 500, bytes: 2 * 1024 * 1024 });
const safeStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
const STORAGE_KEY = 'ash.desktop.saved-history.v1';
export const workKey = work => JSON.stringify([work.node_id, work.endpoint_id, work.kind, work.native_id]);
export const targetKey = target => JSON.stringify([target.device_id, target.node_id, target.endpoint_id, target.authorization_generation, target.authorization_revision]);
export function validTarget(t) {
  return !!t && typeof t.device_id === 'string' && typeof t.node_id === 'string' && typeof t.endpoint_id === 'string' && t.device_id === `device:${t.node_id}` && t.endpoint_id === t.node_id && Number.isSafeInteger(t.authorization_generation) && t.authorization_generation >= 1 && /^[a-f0-9]{64}$/.test(t.authorization_revision) && t.authorization_state === 'ready' && t.source === 'codex.saved_history' && t.runtime_state === 'unknown' && t.control === 'unsupported' && Array.isArray(t.actions) && t.actions.includes('list_work') && t.actions.includes('read_work');
}
const safeWork = w => ({ node_id: w.node_id, endpoint_id: w.endpoint_id, kind: w.kind, native_id: w.native_id });
const validWork = (w, t) => w && w.node_id === t.node_id && w.endpoint_id === t.endpoint_id && w.kind === 'conversation' && typeof w.native_id === 'string' && w.native_id.length > 0;
export function cleanPage(page, target, work = null) {
  if (!page || !Array.isArray(page.items) || page.items.length > 500 || page.source !== 'codex.saved_history' || page.runtime_state !== 'unknown' || page.completeness !== 'source_page' || typeof page.observed_at !== 'string' || !Number.isFinite(Date.parse(page.observed_at)) || !(page.next_cursor === null || (typeof page.next_cursor === 'string' && page.next_cursor.length > 0 && page.next_cursor.length <= 8192))) throw new Error('桌面历史数据无效');
  const items = page.items.map(row => {
    if (!work) {
      if (!validWork(row.work, target) || typeof row.title !== 'string' || typeof row.cwd !== 'string' || !(row.updated_at === null || Number.isFinite(row.updated_at))) throw new Error('会话引用无效');
      return { work: safeWork(row.work), title: row.title, cwd: row.cwd, updated_at: row.updated_at, runtime_state: 'unknown' };
    }
    if (typeof row.turn_id !== 'string' || !Array.isArray(row.messages)) throw new Error('历史轮次无效');
    return { turn_id: row.turn_id, history_status: typeof row.history_status === 'string' ? row.history_status : null, status_source: 'codex.saved_history', messages: row.messages.map(m => {
      if (!validWork(m.work, target) || workKey(m.work) !== workKey(work) || m.turn_id !== row.turn_id || typeof m.source_message_id !== 'string' || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') throw new Error('历史消息无效');
      const message = { work: safeWork(work), turn_id: row.turn_id, source_message_id: m.source_message_id, role: m.role, text: m.text };
      if (typeof m.source_client_message_id === 'string') message.source_client_message_id = m.source_client_message_id;
      if (['commentary', 'final_answer'].includes(m.phase)) message.phase = m.phase;
      message.material_refs = (Array.isArray(m.material_refs) ? m.material_refs : []).filter(r => r.availability === 'reference_only' && ['image', 'audio', 'skill', 'mention'].includes(r.kind) && Number.isSafeInteger(r.source_part_index) && r.source_part_index >= 0).map(r => ({ kind: r.kind, source_part_index: r.source_part_index, availability: 'reference_only' }));
      return message;
    }) };
  });
  return { items, next_cursor: page.next_cursor, observed_at: page.observed_at, source: page.source, completeness: page.completeness, runtime_state: page.runtime_state };
}
export class DesktopWorkStore {
  constructor({ storage = safeStorage(), now = Date.now, limits = CACHE_LIMITS, endpoint = globalThis.location?.origin || "local" } = {}) {
    this.endpoint = endpoint; this.storage = storage; this.persistent = !!storage; this.now = now; this.limits = limits; this.scope = null; this.entries = {}; this.targets = [];
  }
  bind(scope) {
    if (this.scope === scope) return;
    this.scope = scope; this.entries = {}; this.targets = [];
    try {
      const data = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
      if (data?.scope === scope && data.endpoint === this.endpoint && Array.isArray(data.targets) && data.entries && typeof data.entries === 'object') { this.targets = data.targets.filter(validTarget); this.entries = data.entries; }
      else this.storage?.removeItem(STORAGE_KEY);
    } catch { /* an unavailable store never blocks reading */ }
    this.save();
  }
  invalidate() { this.entries = {}; this.targets = []; this.save(); }
  reconcile(targets) {
    const allowed = new Set(targets.filter(validTarget).map(targetKey));
    for (const [key, entry] of Object.entries(this.entries)) if (!allowed.has(entry.target)) delete this.entries[key];
    this.targets = targets.filter(validTarget).map(t => ({ ...t })); this.save();
  }
  key(target, work) { return JSON.stringify([this.endpoint, this.scope, targetKey(target), work ? workKey(work) : 'list']); }
  get(target, work = null) {
    this.prune();
    const entry = this.entries[this.key(target, work)];
    if (!entry) return null;
    try { return { ...entry, page: cleanPage(entry.page, target, work) }; } catch { delete this.entries[this.key(target, work)]; return null; }
  }
  // Work pages are chronological here; DesktopWork normalizes the desktop descending wire pages.
  put(target, work, page, { older = false } = {}) {
    if (!Array.isArray(page?.items) || page.items.length > 100) throw new Error('历史页过大');
    const clean = cleanPage(page, target, work), key = this.key(target, work), previous = this.get(target, work);
    let items = previous?.page.items || [];
    const oldIDs = new Set(items.map(row => work ? row.turn_id : workKey(row.work)));
    const overlaps = clean.items.some(row => oldIDs.has(work ? row.turn_id : workKey(row.work)));
    if (work) {
      const turns = new Map(items.map(turn => [turn.turn_id, turn]));
      for (const turn of clean.items) {
        const prior = turns.get(turn.turn_id);
        const messages = new Map((prior?.messages || []).map(m => [m.source_message_id, m]));
        for (const message of turn.messages) messages.set(message.source_message_id, message);
        turns.set(turn.turn_id, { ...turn, messages: [...messages.values()] });
      }
      const order = items.map(t => t.turn_id), incoming = clean.items.map(t => t.turn_id);
      for (let index = 0; index < incoming.length; index++) {
        const id = incoming[index]; if (order.includes(id)) continue;
        const next = incoming.slice(index + 1).find(value => order.includes(value));
        const prior = incoming.slice(0, index).reverse().find(value => order.includes(value));
        const gapStart = previous?.gap_start_id;
        const position = next ? order.indexOf(next) : prior ? order.indexOf(prior) + 1 : older && gapStart && order.includes(gapStart) ? order.indexOf(gapStart) : older ? 0 : order.length;
        order.splice(position, 0, id);
      }
      items = order.map(id => turns.get(id));
    } else {
      const rows = new Map(items.map(row => [workKey(row.work), row]));
      for (const row of clean.items) rows.set(workKey(row.work), row);
      items = [...rows.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, this.limits.works);
    }
    let incomplete = previous?.incomplete || false;
    if (work) {
      let remaining = this.limits.messages ?? 500;
      items = items.slice().reverse().map(turn => {
        const messages = turn.messages.slice(-Math.max(0, remaining));
        if (remaining <= 0) messages.length = 0;
        if (messages.length !== turn.messages.length) incomplete = true;
        remaining -= messages.length;
        return { ...turn, messages };
      }).filter(turn => turn.messages.length).reverse();
    }
    let gap_cursor = previous?.gap_cursor ?? null, gap_old_ids = previous?.gap_old_ids ?? [], gap_start_id = previous?.gap_start_id ?? null;
    let older_cursor = older ? clean.next_cursor : previous ? previous.older_cursor : clean.next_cursor;
    if (older && previous?.gap_cursor) {
      const joined = clean.items.some(row => gap_old_ids.includes(work ? row.turn_id : workKey(row.work)));
      gap_cursor = joined ? null : clean.next_cursor;
      gap_start_id = clean.items.length ? work ? clean.items[0].turn_id : workKey(clean.items[0].work) : gap_start_id;
      older_cursor = previous.older_cursor;
    } else if (!older && previous && oldIDs.size && !overlaps && clean.next_cursor) {
      gap_cursor = clean.next_cursor; gap_old_ids = gap_old_ids.length ? gap_old_ids : [...oldIDs];
      gap_start_id = work ? clean.items[0].turn_id : workKey(clean.items[0].work);
    }
    if (!gap_cursor) { gap_old_ids = []; gap_start_id = null; }
    const entry = { incomplete, gap_cursor, gap_old_ids, gap_start_id, target: targetKey(target), saved_at: this.now(), page: { ...clean, items }, latest_cursor: older ? previous?.latest_cursor ?? null : clean.next_cursor, older_cursor };
    if (older && clean.next_cursor !== null && clean.next_cursor === (previous?.gap_cursor || previous?.older_cursor)) { if (previous?.gap_cursor) entry.gap_cursor = null; else entry.older_cursor = null; entry.incomplete = true; }
    this.entries[key] = entry; this.save(); if (!this.entries[key]) entry.incomplete = true; return entry;
  }
  prune() {
    for (const [key, entry] of Object.entries(this.entries)) if (!entry || !Number.isFinite(entry.saved_at) || this.now() - entry.saved_at > this.limits.ttl) delete this.entries[key];
    let rows = Object.entries(this.entries).sort((a, b) => b[1].saved_at - a[1].saved_at);
    for (const [key] of rows.slice(this.limits.works)) delete this.entries[key];
    const size = () => new TextEncoder().encode(JSON.stringify({ endpoint: this.endpoint, scope: this.scope, entries: this.entries, targets: this.targets })).length;
    while (rows.length && size() > this.limits.bytes) { const [key] = rows.pop(); delete this.entries[key]; }
  }
  save() { this.prune(); try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ endpoint: this.endpoint, scope: this.scope, entries: this.entries, targets: this.targets })); } catch { this.persistent = false; try { this.storage?.removeItem(STORAGE_KEY); } catch {} } }
}

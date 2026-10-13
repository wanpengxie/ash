const bytes = text => new TextEncoder().encode(text).length;
const disk = () => { try { return globalThis.localStorage; } catch { return null; } };
const TTL = 86400000;
const LIMIT = 192 * 1024;
export const joinSharedText = (draft, text) => text ? draft ? `${draft}\n\n${text}` : text : draft;
// A small scoped snapshot reuses the same synchronous storage as operation receipts.
export class DesktopSharedDrafts {
  constructor({ storage = disk(), endpoint = '', now = Date.now, requireStorage = false } = {}) {
    this.storage = storage; this.key = `ash.desktop.unsent-drafts.v1:${endpoint}`; this.now = now; this.requireStorage = requireStorage;
    this.scope = null; this.scopes = Object.create(null); this.pending = ''; this.seen = new Set(); this.saved = new Map();
    try {
      const raw = storage?.getItem(this.key);
      if (raw && bytes(raw) <= 2 * 1024 * 1024) {
        const data = JSON.parse(raw);
        if (data?.version === 1 && Array.isArray(data.scopes) && data.scopes.length <= 4) for (const s of data.scopes) {
          if (typeof s.scope !== 'string' || !s.scope || !Number.isSafeInteger(s.updated) || s.updated > now() || s.updated <= now() - TTL || typeof s.pending !== 'string' || bytes(s.pending) > 64 * 1024 || !Array.isArray(s.seen) || s.seen.length > 64 || !s.seen.every(id => typeof id === 'string' && id.length <= 256) || !Array.isArray(s.saved) || s.saved.length > 2 || !s.saved.every(v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && v[0].length <= 16384 && typeof v[1] === 'string' && bytes(v[1]) <= LIMIT)) continue;
          this.scopes[s.scope] = s;
        }
      }
    } catch { /* unavailable or invalid storage never restores text */ }
  }
  bind(scope) {
    if (this.scope === scope) return;
    this.scope = scope; const s = this.scopes[scope];
    this.pending = s?.pending || ''; this.seen = new Set(s?.seen || []); this.saved = new Map(s?.saved || []);
  }
  commit(saved = this.saved, pending = this.pending, seen = this.seen) {
    if (!this.scope) return !this.requireStorage;
    const scopes = Object.values(this.scopes).filter(s => s.scope !== this.scope && s.updated > this.now() - TTL);
    if (saved.size || pending || seen.size) scopes.push({ scope: this.scope, updated: this.now(), pending, seen: [...seen], saved: [...saved] });
    if (scopes.length > 4) return false;
    const raw = JSON.stringify({ version: 1, scopes });
    if (bytes(raw) > 2 * 1024 * 1024) return false;
    try {
      if (!this.storage && this.requireStorage) return false;
      this.storage?.setItem(this.key, raw);
      if (this.storage && this.storage.getItem(this.key) !== raw) return false;
    } catch { return false; }
    this.scopes = Object.fromEntries(scopes.map(s => [s.scope, s])); this.saved = saved; this.pending = pending; this.seen = seen; return true;
  }
  clear() { return this.commit(new Map(), '', new Set()); }
  slot(kind, key) { return JSON.stringify([kind, key]); }
  forget(kind, key) { const saved = new Map(this.saved); saved.delete(this.slot(kind, key)); return this.commit(saved); }
  remember(kind, key, text) {
    if (!key) return true;
    if (typeof text !== 'string' || bytes(text) > LIMIT) return false;
    const slot = this.slot(kind, key), saved = new Map(this.saved);
    if (!text) saved.delete(slot);
    else { if (!saved.has(slot) && saved.size >= 2) return false; saved.set(slot, text); }
    return this.commit(saved);
  }
  stage(share) {
    if (!share || typeof share !== 'object' || Array.isArray(share) || Object.keys(share).some(k => !['id', 'text'].includes(k)) || typeof share.id !== 'string' || !share.id || share.id.length > 256 || /[\u0000-\u001f]/.test(share.id) || typeof share.text !== 'string' || !share.text.trim() || bytes(share.text) > 32 * 1024) return false;
    if (this.seen.has(share.id)) return true;
    const pending = joinSharedText(this.pending, share.text); if (bytes(pending) > 64 * 1024) return false;
    const seen = new Set(this.seen); if (seen.size >= 64) seen.delete(seen.values().next().value); seen.add(share.id);
    return this.commit(this.saved, pending, seen);
  }
  fullFor(kind, key) { return this.saved.size >= 2 && !this.saved.has(this.slot(kind, key)); }
  take(kind, key, draft) {
    this.takeError = null;
    if (this.pending && this.fullFor(kind, key)) return null;
    const slot = this.slot(kind, key), saved = this.saved.get(slot), base = draft || saved || '';
    if (!this.pending && base === draft) return null;
    const next = joinSharedText(base, this.pending); if (bytes(next) > LIMIT) { this.takeError = 'too_large'; return null; }
    if (!this.rememberAndConsume(slot, next)) { this.takeError = 'storage_failure'; return null; }
    return next;
  }
  rememberAndConsume(slot, text) { const saved = new Map(this.saved); saved.set(slot, text); return this.commit(saved, ''); }
}

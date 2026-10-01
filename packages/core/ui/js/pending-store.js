const DB_NAME = "ash-v2-owner-pending-say";
const STORE = "pending";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 45_000;
const MAX_ITEMS = 24;
const MAX_BYTES = 96 * 1024 * 1024;
const encodedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const keyFor = (endpoint, scope, clientId) => JSON.stringify([endpoint, scope, clientId]);
const namespaceFor = (endpoint, scope) => JSON.stringify([endpoint, scope]);

export function openPendingStore(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) return Promise.reject(new Error("pending storage unavailable"));
  return new Promise((resolve, reject) => {
    const opening = indexedDb.open(DB_NAME, 2);
    opening.onupgradeneeded = (event) => {
      const store = opening.result.objectStoreNames.contains(STORE) ? opening.transaction.objectStore(STORE) : opening.result.createObjectStore(STORE, { keyPath: "key" });
      if (!store.indexNames.contains("namespace")) store.createIndex("namespace", "namespace");
      if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
      if (event.oldVersion === 1) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const item = entry.value;
          if (typeof item.endpoint === "string" && typeof item.scope === "string" && !item.namespace) entry.update({ ...item, namespace: namespaceFor(item.endpoint, item.scope) });
          entry.continue();
        };
      }
    };
    opening.onsuccess = () => resolve(new PendingStore(opening.result));
    opening.onerror = () => reject(new Error("pending storage unavailable"));
    opening.onblocked = () => reject(new Error("pending storage upgrade blocked"));
  });
}

export class PendingStore {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  transaction(mode, run) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error("pending storage unavailable"));
      tx.onabort = () => reject(new Error("pending storage unavailable"));
      try { run(store, (value) => { result = value; }, tx); }
      catch { tx.abort(); }
    });
  }
  async list(endpoint, scope, now = Date.now()) {
    return this.transaction("readwrite", (store, set) => {
      const expiry = store.index("createdAt").openKeyCursor(IDBKeyRange.upperBound(now - TTL_MS));
      expiry.onsuccess = () => { const cursor = expiry.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
      const all = store.index("namespace").getAll(IDBKeyRange.only(namespaceFor(endpoint, scope)));
      all.onsuccess = () => {
        const items = [];
        for (const item of all.result) {
          if (now - item.createdAt >= TTL_MS) { store.delete(item.key); continue; }
          if (item.id && item.wire) { item.wire = null; item.bytes = 0; store.put(item); }
          items.push(item);
        }
        set(items.sort((a, b) => a.createdAt - b.createdAt));
      };
    });
  }
  async enqueue(endpoint, scope, wire, now = Date.now()) {
    const size = encodedBytes(wire);
    if (size > 28 * 1024 * 1024) throw new Error("message exceeds request limit");
    const key = keyFor(endpoint, scope, wire.client_id);
    return this.transaction("readwrite", (store, set, tx) => {
      const all = store.index("namespace").getAll(IDBKeyRange.only(namespaceFor(endpoint, scope)));
      all.onsuccess = () => {
        const retained = all.result.filter((item) => now - item.createdAt < TTL_MS);
        for (const expired of all.result) if (now - expired.createdAt >= TTL_MS) store.delete(expired.key);
        if (retained.some((item) => item.key === key) || retained.length >= MAX_ITEMS || retained.reduce((total, item) => total + (item.bytes || 0), size) > MAX_BYTES) { tx.abort(); return; }
        const item = { key, endpoint, scope, namespace: namespaceFor(endpoint, scope), client_id: wire.client_id, text: wire.body.text, attachments: wire.body.attachments?.map(({ name, mime_type, data }) => ({ name, mime_type, size: Math.floor(data.length * 3 / 4) })) || [], wire, bytes: size, status: "unsent", id: null, seq: null, createdAt: now, updatedAt: now, leaseOwner: null, leaseUntil: 0 };
        store.add(item); set(item);
      };
    }).catch(() => { throw new Error("pending storage full or unavailable"); });
  }
  async claim(endpoint, scope, owner, now = Date.now()) {
    return this.transaction("readwrite", (store, set) => {
      const all = store.index("namespace").getAll(IDBKeyRange.only(namespaceFor(endpoint, scope)));
      all.onsuccess = () => {
        const eligible = all.result.filter((item) => item.endpoint === endpoint && item.scope === scope && item.wire && !item.id && item.status !== "rejected" && now - item.createdAt < TTL_MS)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!eligible) { set(null); return; }
        if (eligible.leaseOwner && eligible.leaseUntil > now && eligible.leaseOwner !== owner) { set({ blockedUntil: eligible.leaseUntil }); return; }
        eligible.leaseOwner = owner; eligible.leaseUntil = now + LEASE_MS; eligible.status = "sending"; eligible.updatedAt = now;
        store.put(eligible); set(eligible);
      };
    });
  }
  async release(item, owner, status, now = Date.now()) {
    return this.transaction("readwrite", (store) => {
      const current = store.get(item.key);
      current.onsuccess = () => {
        if (!current.result || current.result.leaseOwner !== owner || current.result.id) return;
        store.put({ ...current.result, status, leaseOwner: null, leaseUntil: 0, updatedAt: now });
      };
    });
  }
  async renew(item, owner, now = Date.now()) {
    return this.transaction("readwrite", (store) => {
      const current = store.get(item.key);
      current.onsuccess = () => {
        if (current.result?.leaseOwner === owner && !current.result.id) store.put({ ...current.result, leaseUntil: now + LEASE_MS });
      };
    });
  }
  async accept(item, owner, id, seq, now = Date.now()) {
    if (typeof id !== "string" || !id || !Number.isSafeInteger(seq) || seq < 1) throw new Error("invalid send acknowledgement");
    // First commit the durable server identity while original bytes still exist.
    await this.transaction("readwrite", (store, set, tx) => {
      const current = store.get(item.key);
      current.onsuccess = () => {
        if (!current.result || current.result.leaseOwner !== owner) { tx.abort(); return; }
        store.put({ ...current.result, status: "accepted", id, seq, leaseOwner: null, leaseUntil: 0, updatedAt: now });
        set(true);
      };
    });
    // A crash before this second transaction leaves recoverable bytes, never an untracked send.
    await this.transaction("readwrite", (store) => {
      const current = store.get(item.key);
      current.onsuccess = () => {
        if (!current.result || current.result.id !== id || current.result.seq !== seq) return;
        store.put({ ...current.result, wire: null, bytes: 0, attachments: current.result.attachments });
      };
    });
  }
  async removeAccepted(endpoint, scope, id) {
    return this.transaction("readwrite", (store) => {
      const all = store.index("namespace").getAll(IDBKeyRange.only(namespaceFor(endpoint, scope)));
      all.onsuccess = () => { for (const item of all.result) if (item.id === id) store.delete(item.key); };
    });
  }
}

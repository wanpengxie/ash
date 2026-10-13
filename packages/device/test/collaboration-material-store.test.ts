import { FixtureCustodyRegistry } from './fixtures/material-custody-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open, realpath, readdir, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MaterialAssetStore, type MaterialAssetStoreOptions, type MaterialStoreBinding } from '../src/collaboration/material-store';
import { MaterialTransferService } from '../src/collaboration/material-transfer';
import { MATERIAL_LIMITS, MaterialProtocolError, type AssetInputs, type AssetOperation, type MaterialAuthorization, type MaterialTrustedContext, type MaterialAuthorizationScope, type TransferFact } from '../src/collaboration/material-types';
const src = { kind: 'node' as const, node_id: 'phone', endpoint_id: 'materials' }, dst = { kind: 'work' as const, work: { node_id: 'mac', endpoint_id: 'codex', kind: 'conversation' as const, native_id: 'real-fixture-conversation' } };
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Scope = Extract<MaterialAuthorizationScope, {
    kind: 'request';
    action: AssetOperation;
}>;
async function fixture(options: Partial<MaterialAssetStoreOptions> = {}) {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'ash-material-'));
    let now = 1000, epoch = '1', revoked = false;
    const context: MaterialTrustedContext = { principal_id: 'phone-principal', pairing_id: 'phone-pair', grant_revision: 'r', authorization_epoch: epoch, source_binding: src, expires_at: 1e10 };
    const check = (c: MaterialTrustedContext) => {
        if (revoked || c.authorization_epoch !== epoch || now >= c.expires_at)
            throw new MaterialProtocolError('permission_denied');
    };
    const auth: MaterialAuthorization = { before: async (c) => { check(c); return structuredClone(c); }, after: async (c) => { check(c); }, current: c => { check(c); return undefined; } };
    const registry = new FixtureCustodyRegistry(check, () => now);
    const localStoreId = options.localStoreId ?? 'mac-store';
    const config: MaterialAssetStoreOptions = { custody: registry.authority(localStoreId), localStoreId, rootDir: join(dir, 'store'), authorization: auth, clock: () => now, ...options };
    let store = new MaterialAssetStore(config);
    const offers = new Map<string, AssetInputs['offer']>();
    function offer(bytes: Uint8Array = Buffer.from('hello'), id = 'asset', reverse = false, expiresAt = 1e9): AssetInputs['offer'] { const result: AssetInputs['offer'] = { version: 1, request_id: 'request', asset: { kind: 'asset', asset_id: id, version: 1, sha256: hash(bytes), byte_length: bytes.length, media_type: 'application/octet-stream', display_name: '../../display-only', provenance: [], expires_at: expiresAt }, source: reverse ? dst : src, destination: reverse ? src : dst, expires_at: expiresAt }; registry.register(result); offers.set(id, result); return result; }
    function scope(operation: AssetOperation, input: AssetInputs[AssetOperation]): Scope { const asset = 'asset' in input ? input.asset : { asset_id: input.asset_id, version: input.asset_version }; return { kind: 'request', action: operation, request_id: 'request', source: src, return_to: src, target: dst, transfer: { asset_id: asset.asset_id, asset_version: asset.version, source: offers.get(asset.asset_id)?.source ?? src, destination: offers.get(asset.asset_id)?.destination ?? dst } }; }
    async function binding(op: AssetOperation, input: AssetInputs[AssetOperation]): Promise<MaterialStoreBinding> { const s = scope(op, input), endpoint = op === 'ack' || op === 'read_chunk' ? s.transfer.destination : s.transfer.source, node = endpoint.kind === 'node' ? endpoint.node_id : endpoint.work.node_id, c = { ...context, principal_id: node === 'phone' ? 'phone-principal' : 'work-principal', pairing_id: registry.pairingFor(node), authorization_epoch: epoch, source_binding: endpoint }; return { context: c, scope: s, lease: await auth.before(c, s) }; }
    function identity(f: TransferFact) { return { version: 1 as const, transfer_id: f.transfer_id, request_id: f.request_id, asset_id: f.asset_id, asset_version: f.asset_version }; }
    async function upload(bytes: Buffer, id = 'asset') {
        const o = offer(bytes, id), f = await store.offer(o, await binding('offer', o));
        for (let offset = 0; offset < bytes.length; offset += MATERIAL_LIMITS.chunk_bytes) {
            const c = { ...identity(f), chunk_index: offset / MATERIAL_LIMITS.chunk_bytes, data_base64: bytes.subarray(offset, offset + MATERIAL_LIMITS.chunk_bytes).toString('base64') };
            await store.putChunk(c, await binding('put_chunk', c));
        }
        const i = identity(f);
        return store.commit(i, await binding('commit', i));
    }
    return { dir, config, registry, auth, offer, binding, identity, upload, get store() { return store; }, setNow: (v: number) => { now = v; }, rotate: (node: string, pairing: string) => { epoch = String(Number(epoch) + 1); registry.replacePairing(node, pairing); }, revoke: () => { revoked = true; epoch = String(Number(epoch) + 1); registry.advanceGeneration(); }, restore: () => { revoked = false; }, reopen: async () => { await store.close(); store = new MaterialAssetStore(config); }, cleanup: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof MaterialProtocolError && e.code === code);
test('durable out-of-order resume, read and ACK survive reopen with original receipt', async () => {
    const f = await fixture();
    try {
        const bytes = Buffer.alloc(MATERIAL_LIMITS.chunk_bytes + 3, 7), o = f.offer(bytes), first = await f.store.offer(o, await f.binding('offer', o));
        const i = f.identity(first), tail = { ...i, chunk_index: 1, data_base64: bytes.subarray(MATERIAL_LIMITS.chunk_bytes).toString('base64') };
        await f.store.putChunk(tail, await f.binding('put_chunk', tail));
        await f.reopen();
        const resumed = await f.store.offer(o, await f.binding('offer', o));
        assert.equal(resumed.transfer_id, first.transfer_id);
        assert.deepEqual(resumed.received_chunks, [1]);
        const head = { ...i, chunk_index: 0, data_base64: bytes.subarray(0, MATERIAL_LIMITS.chunk_bytes).toString('base64') };
        await f.store.putChunk(head, await f.binding('put_chunk', head));
        const committed = await f.store.commit(i, await f.binding('commit', i));
        await f.reopen();
        assert.deepEqual((await f.store.commit(i, await f.binding('commit', i))).receipt, committed.receipt);
        const read = { ...i, chunk_index: 1 };
        assert.equal((await f.store.readChunk(read, await f.binding('read_chunk', read))).data_base64, tail.data_base64);
        const ack = { ...i, receipt_id: committed.receipt!.receipt_id };
        assert.equal((await f.store.ack(ack, await f.binding('ack', ack))).state, 'acknowledged');
        await f.reopen();
        assert.deepEqual((await f.store.ack(ack, await f.binding('ack', ack))).receipt, committed.receipt);
    }
    finally {
        await f.cleanup();
    }
});
test('two independent instances serialize simultaneous offers and chunks', async () => {
    const f = await fixture();
    const other = new MaterialAssetStore(f.config);
    try {
        const o = f.offer(), b = await f.binding('offer', o);
        const a = await f.store.offer(o, b);
        const all = await Promise.all([other.offer(o, b), f.store.offer(o, b)]);
        assert.ok(all.every(v => v.transfer_id === a.transfer_id));
        const c = { ...f.identity(a), chunk_index: 0, data_base64: Buffer.from('hello').toString('base64') }, cb = await f.binding('put_chunk', c);
        await Promise.all([f.store.putChunk(c, cb), other.putChunk(c, cb)]);
        await rejects(() => other.putChunk({ ...c, data_base64: Buffer.from('jello').toString('base64') }, cb), 'conflict');
    }
    finally {
        await other.close();
        await f.cleanup();
    }
});
test('zero byte and 4MiB boundary assets commit with verified receipts', async () => {
    const f = await fixture();
    try {
        const zero = await f.upload(Buffer.alloc(0), 'zero');
        assert.equal(zero.receipt!.byte_length, 0);
        const max = await f.upload(Buffer.alloc(MATERIAL_LIMITS.file_bytes, 13), 'max');
        assert.equal(max.receipt!.byte_length, MATERIAL_LIMITS.file_bytes);
        assert.equal(max.received_chunks.length, 103);
    }
    finally {
        await f.cleanup();
    }
});
test('chunk fixed index, exact tail, wrong hash, immutable offer conflict', async () => {
    const f = await fixture();
    try {
        const o = f.offer(), a = await f.store.offer(o, await f.binding('offer', o)), i = f.identity(a);
        const short = { ...i, chunk_index: 0, data_base64: 'YQ==' };
        const b = await f.binding('put_chunk', short);
        await rejects(() => f.store.putChunk(short, b), 'invalid');
        const wrong = { ...i, chunk_index: 0, data_base64: Buffer.from('xxxxx').toString('base64') };
        await f.store.putChunk(wrong, await f.binding('put_chunk', wrong));
        await rejects(async () => f.store.commit(i, await f.binding('commit', i)), 'hash_mismatch');
        const changed = { ...o, asset: { ...o.asset, sha256: hash(Buffer.from('jello')) } };
        await rejects(async () => f.store.offer(changed, await f.binding('offer', changed)), 'conflict');
    }
    finally {
        await f.cleanup();
    }
});
test('durable quota reservation, tombstones and bounded metadata reject reopening', async () => {
    const f = await fixture({ limits: { principal_bytes: 5, principal_files: 1 }, maxMetadataRecords: 1 });
    try {
        const o = f.offer(), a = await f.store.offer(o, await f.binding('offer', o));
        const other = f.offer(Buffer.from('x'), 'two');
        await rejects(async () => f.store.offer(other, await f.binding('offer', other)), 'too_large');
        f.setNow(MATERIAL_LIMITS.temporary_ttl_ms + 1001);
        const i = f.identity(a);
        assert.equal((await f.store.collectExpired(i, await f.binding('commit', i))).state, 'expired');
        await f.reopen();
        await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'expired');
        await rejects(async () => f.store.offer(other, await f.binding('offer', other)), 'too_large');
    }
    finally {
        await f.cleanup();
    }
});
for (const point of ['prepare_durable', 'renamed', 'commit_durable'] as const)
    test(`interrupted ${point} resumes from durable exact proof`, async () => {
        let once = true;
        const f = await fixture({ fault: p => {
                if (p === point && once) {
                    once = false;
                    throw new Error('crash');
                }
            } });
        try {
            await assert.rejects(() => f.upload(Buffer.from('hello')), /crash/);
            await f.reopen();
            const o = f.offer(), fact = await f.store.offer(o, await f.binding('offer', o));
            assert.equal(fact.state, 'committed');
            assert.equal(fact.receipt!.sha256, o.asset.sha256);
        }
        finally {
            await f.cleanup();
        }
    });
test('ACK loss recovers same receipt and acknowledged state', async () => {
    let lost = true;
    const f = await fixture({ fault: p => {
            if (p === 'ack_durable' && lost) {
                lost = false;
                throw new Error('ack lost');
            }
        } });
    try {
        const a = await f.upload(Buffer.from('hello')), i = { ...f.identity(a), receipt_id: a.receipt!.receipt_id };
        await assert.rejects(async () => f.store.ack(i, await f.binding('ack', i)), /ack lost/);
        await f.reopen();
        assert.deepEqual((await f.store.ack(i, await f.binding('ack', i))).receipt, a.receipt);
    }
    finally {
        await f.cleanup();
    }
});
test('revocation ABA during asynchronous IO rejects old lease success and error', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ fault: p => {
            if (p === 'chunk_synced') {
                f.revoke();
                f.restore();
            }
        } });
    try {
        const o = f.offer(), a = await f.store.offer(o, await f.binding('offer', o)), c = { ...f.identity(a), chunk_index: 0, data_base64: Buffer.from('hello').toString('base64') };
        const b = await f.binding('put_chunk', c);
        await rejects(() => f.store.putChunk(c, b), 'permission_denied');
        await rejects(() => f.store.putChunk(c, b), 'permission_denied');
        assert.deepEqual((await f.store.offer(o, await f.binding('offer', o))).received_chunks, []);
    }
    finally {
        await f.cleanup();
    }
});
test('wrong principal, request, directional binding and scope are denied', async () => {
    const f = await fixture();
    try {
        const a = await f.upload(Buffer.from('hello')), i = f.identity(a), b = await f.binding('commit', i);
        await rejects(() => f.store.commit(i, { ...b, context: { ...b.context, principal_id: 'other' }, lease: { ...b.lease, principal_id: 'other' } }), 'permission_denied');
        await rejects(() => f.store.commit({ ...i, request_id: 'other' }, b), 'permission_denied');
        await rejects(() => f.store.commit(i, { ...b, scope: { ...b.scope, transfer: { ...b.scope.transfer, destination: src } } }), 'permission_denied');
    }
    finally {
        await f.cleanup();
    }
});
test('registerSnapshot accepts an opened user handle; rejects hardlinks and changed hashes', async () => {
    const f = await fixture({ localStoreId: 'phone-store' });
    try {
        const source = join(f.dir, 'user-file');
        await writeFile(source, 'hello');
        const h = await open(source, 'r');
        try {
            const o = f.offer();
            assert.deepEqual(await f.store.registerSnapshot(o, { handle: h, user_registered: true }, await f.binding('offer', o)), o.asset);
        }
        finally {
            await h.close();
        }
        await link(source, join(f.dir, 'hardlink'));
        const h2 = await open(source, 'r');
        try {
            const o = f.offer(Buffer.from('hello'), 'hard');
            await rejects(async () => f.store.registerSnapshot(o, { handle: h2, user_registered: true }, await f.binding('offer', o)), 'permission_denied');
        }
        finally {
            await h2.close();
        }
        await unlink(join(f.dir, 'hardlink'));
        await writeFile(source, 'jello');
        const h3 = await open(source, 'r');
        try {
            const o = f.offer(Buffer.from('hello'), 'changed');
            await rejects(async () => f.store.registerSnapshot(o, { handle: h3, user_registered: true }, await f.binding('offer', o)), 'hash_mismatch');
        }
        finally {
            await h3.close();
        }
    }
    finally {
        await f.cleanup();
    }
});
for (const kind of ['symlink', 'hardlink'] as const)
    test(`controlled destination ${kind} substitution is rejected`, async () => {
        const f = await fixture();
        try {
            const a = await f.upload(Buffer.from('hello')), bytesDir = join(f.config.rootDir, 'bytes'), name = (await readdir(bytesDir)).find(v => v.endsWith('.asset'))!, path = join(bytesDir, name), evil = join(f.dir, 'evil');
            await writeFile(evil, 'hello');
            await unlink(path);
            if (kind === 'symlink')
                await symlink(evil, path);
            else
                await link(evil, path);
            const read = { ...f.identity(a), chunk_index: 0 };
            await assert.rejects(async () => f.store.readChunk(read, await f.binding('read_chunk', read)));
        }
        finally {
            await f.cleanup();
        }
    });
test('wire service strict encoded size, current injection and closed store', async () => {
    const f = await fixture();
    try {
        const service = new MaterialTransferService({ store: f.store, authorization: f.auth, currentContext: c => f.auth.current(c, { kind: 'discovery', action: 'discover', target: { node_id: 'phone', endpoint_id: 'materials' } }), resolveScope: async (op, input) => (await f.binding(op, input)).scope });
        const o = f.offer();
        const fact = await service.invoke('offer', o, (await f.binding('offer', o)).context);
        assert.equal(fact.state, 'offered');
        const oversized = { ...f.identity(fact), chunk_index: 0, data_base64: 'A'.repeat(70000) };
        await rejects(async () => service.invoke('put_chunk', oversized, (await f.binding('put_chunk', oversized)).context), 'too_large');
        await f.store.close();
        await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'offline');
    }
    finally {
        await f.cleanup();
    }
});
test('mutable resolver output/context cannot revive captured epoch after ABA', async () => {
    const f = await fixture();
    try {
        const o = f.offer(), bound = await f.binding('offer', o);
        let release!: () => void;
        const waiting = new Promise<void>(r => release = r);
        const service = new MaterialTransferService({ store: f.store, authorization: f.auth, currentContext: c => f.auth.current(c, bound.scope), resolveScope: async () => { await waiting; return bound.scope; } });
        const pending = service.invoke('offer', o, bound.context);
        f.revoke();
        f.restore();
        bound.context.authorization_epoch = '2';
        release();
        await rejects(() => pending, 'permission_denied');
    }
    finally {
        await f.cleanup();
    }
});
test('unknown reservation remains bounded after expiry and never guesses orphan bytes', async () => {
    let interrupted = true;
    const f = await fixture({ limits: { principal_files: 1 }, fault: p => {
            if (p === 'reserved' && interrupted) {
                interrupted = false;
                throw new Error('interrupt');
            }
        } });
    try {
        const o = f.offer();
        await assert.rejects(async () => f.store.offer(o, await f.binding('offer', o)), /interrupt/);
        await f.reopen();
        const unknown = await f.store.offer(o, await f.binding('offer', o));
        assert.equal(unknown.state, 'unknown');
        f.setNow(MATERIAL_LIMITS.temporary_ttl_ms + 1001);
        assert.equal((await f.store.collectExpired(f.identity(unknown), await f.binding('commit', f.identity(unknown)))).state, 'unknown');
        const newer = f.offer(Buffer.from('a'), 'new');
        await rejects(async () => f.store.offer(newer, await f.binding('offer', newer)), 'too_large');
    }
    finally {
        await f.cleanup();
    }
});
test('metadata byte limit rejects reservation without creating bytes', async () => {
    const f = await fixture({ maxMetadataBytes: 10 });
    try {
        const o = f.offer();
        await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'too_large');
        assert.deepEqual(await readdir(join(f.config.rootDir, 'bytes')), []);
    }
    finally {
        await f.cleanup();
    }
});
test('close drains pending IO and other instance reports retryable busy', async () => {
    let entered!: () => void, release!: () => void;
    const barrier = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const f = await fixture({ busyMs: 15, fault: async (p) => {
            if (p === 'chunk_synced') {
                entered();
                await barrier;
            }
        } });
    const second = new MaterialAssetStore({ ...f.config, fault: undefined });
    try {
        const o = f.offer(), a = await f.store.offer(o, await f.binding('offer', o)), c = { ...f.identity(a), chunk_index: 0, data_base64: Buffer.from('hello').toString('base64') };
        const writing = f.store.putChunk(c, await f.binding('put_chunk', c));
        await started;
        let drained = false;
        const closing = f.store.close().then(() => drained = true);
        await rejects(async () => second.putChunk(c, await f.binding('put_chunk', c)), 'offline');
        assert.equal(drained, false);
        release();
        await writing;
        await closing;
        assert.equal(drained, true);
    }
    finally {
        release();
        await second.close();
        await f.cleanup();
    }
});
for (const point of ['prepare_durable', 'renamed', 'commit_durable'] as const)
    test(`actual subprocess crash at ${point} recovers SQLite journal and exact bytes`, async () => {
        const f = await fixture();
        try {
            const { spawn } = await import('node:child_process');
            const child = spawn(process.execPath, ['--import', 'tsx', new URL('./fixtures/material-store-crash.mjs', import.meta.url).pathname, f.config.rootDir, point], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', b => stderr += String(b));
            const exit = await new Promise<number | null>((res, rej) => { child.once('error', rej); child.once('exit', res); });
            assert.equal(exit, 74, stderr);
            const o = f.offer(), result = await f.store.offer(o, await f.binding('offer', o));
            assert.equal(result.state, 'committed');
            assert.equal(result.receipt!.sha256, o.asset.sha256);
        }
        finally {
            await f.cleanup();
        }
    });
test('two actual actor/pairing endpoint stores transfer source snapshot with zero source receipt', async () => {
    const f = await fixture({ localStoreId: 'phone-store' });
    const destination = new MaterialAssetStore({ ...f.config, rootDir: join(f.dir, 'receiver'), localStoreId: 'mac-store', custody: f.registry.authority('mac-store') });
    try {
        const bytes = Buffer.alloc(MATERIAL_LIMITS.chunk_bytes + 91, 21), o = f.offer(bytes), file = join(f.dir, 'selection');
        await writeFile(file, bytes);
        const h = await open(file, 'r');
        try {
            await f.store.registerSnapshot(o, { handle: h, user_registered: true }, await f.binding('offer', o));
        }
        finally {
            await h.close();
        }
        const lookup = { version: 1 as const, request_id: o.request_id, asset_id: o.asset.asset_id, asset_version: o.asset.version };
        const snapshot = await f.store.getSnapshot(lookup, await f.binding('offer', o));
        await f.reopen();
        const recovered = await f.store.getSnapshot(lookup, await f.binding('offer', o));
        assert.equal(recovered.snapshot_id, snapshot.snapshot_id);
        const receiver = new MaterialTransferService({ store: destination, authorization: f.auth, currentContext: c => f.auth.current(c, (null as never)), resolveScope: async (op, input) => (await f.binding(op, input)).scope });
        const inbound = await receiver.invoke('offer', o, (await f.binding('offer', o)).context);
        for (let index = 0; index < Math.ceil(bytes.length / MATERIAL_LIMITS.chunk_bytes); index++) {
            const bytes = await f.store.readSnapshotChunk(recovered, index, await f.binding('offer', o));
            const chunk = { ...f.identity(inbound), chunk_index: index, data_base64: Buffer.from(bytes).toString('base64') };
            await receiver.invoke('put_chunk', chunk, (await f.binding('put_chunk', chunk)).context);
        }
        const identity = f.identity(inbound), committed = await receiver.invoke('commit', identity, (await f.binding('commit', identity)).context);
        assert.equal(committed.receipt!.sha256, hash(bytes));
        const read = { ...identity, chunk_index: 0 }, reader = await f.binding('read_chunk', read);
        assert.equal(reader.context.principal_id, 'work-principal');
        assert.equal(reader.context.pairing_id, 'work-pair');
        assert.equal((await receiver.invoke('read_chunk', read, reader.context)).data_base64, bytes.subarray(0, MATERIAL_LIMITS.chunk_bytes).toString('base64'));
        const ack = { ...identity, receipt_id: committed.receipt!.receipt_id };
        assert.equal((await receiver.invoke('ack', ack, (await f.binding('ack', ack)).context)).state, 'acknowledged');
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
        try {
            const row = db.prepare('SELECT data FROM transfers_v2').get() as {
                data: string;
            };
            assert.equal(JSON.parse(row.data).receipt, null);
            assert.equal(JSON.parse(row.data).storage_role, 'source_snapshot');
        }
        finally {
            db.close();
        }
    }
    finally {
        await destination.close();
        await f.cleanup();
    }
});
test('ordinary caller binding reuse preserves the captured operation identity', async () => {
    const f = await fixture();
    try {
        const offer = f.offer();
        const reusable = await f.binding('offer', offer);
        const pending = f.store.offer(offer, reusable);
        reusable.context.principal_id = 'next-operation-principal';
        reusable.lease.principal_id = 'next-operation-principal';
        const first = await pending;
        const retry = await f.store.offer(offer, await f.binding('offer', offer));
        assert.equal(retry.transfer_id, first.transfer_id);
    }
    finally {
        await f.cleanup();
    }
});
test('work actor snapshot returns signed chunks to phone actor under one custody owner', async () => {
    const f = await fixture({ localStoreId: 'mac-store' }), receiver = new MaterialAssetStore({ ...f.config, rootDir: join(f.dir, 'phone-receiver'), localStoreId: 'phone-store', custody: f.registry.authority('phone-store') });
    try {
        const bytes = Buffer.from('work result for original phone'), offer = f.offer(bytes, 'reverse-result', true), path = join(f.dir, 'work-result');
        await writeFile(path, bytes);
        const h = await open(path, 'r');
        const writer = await f.binding('offer', offer);
        assert.equal(writer.context.principal_id, 'work-principal');
        assert.equal(writer.context.pairing_id, 'work-pair');
        try {
            await f.store.registerSnapshot(offer, { handle: h, user_registered: true }, writer);
        }
        finally {
            await h.close();
        }
        const snapshot = await f.store.getSnapshot({ version: 1, request_id: offer.request_id, asset_id: offer.asset.asset_id, asset_version: 1 }, writer), incoming = await receiver.offer(offer, writer);
        const raw = await f.store.readSnapshotChunk(snapshot, 0, writer);
        const { generateKeyPairSync, sign, verify } = await import('node:crypto'), keys = generateKeyPairSync('ed25519'), chunk = { ...f.identity(incoming), chunk_index: 0, data_base64: Buffer.from(raw).toString('base64') }, serialized = Buffer.from(JSON.stringify(chunk)), signature = sign(null, serialized, keys.privateKey);
        assert.equal(verify(null, serialized, keys.publicKey, signature), true);
        await receiver.putChunk(JSON.parse(serialized.toString()), await f.binding('put_chunk', chunk));
        const identity = f.identity(incoming), committed = await receiver.commit(identity, await f.binding('commit', identity)), read = { ...identity, chunk_index: 0 }, reader = await f.binding('read_chunk', read);
        assert.equal(reader.context.principal_id, 'phone-principal');
        assert.equal(reader.context.pairing_id, 'phone-pair');
        assert.equal((await receiver.readChunk(read, reader)).data_base64, bytes.toString('base64'));
        const ack = { ...identity, receipt_id: committed.receipt!.receipt_id };
        assert.equal((await receiver.ack(ack, await f.binding('ack', ack))).state, 'acknowledged');
        await receiver.close();
        const reopened = new MaterialAssetStore({ ...f.config, rootDir: join(f.dir, 'phone-receiver'), localStoreId: 'phone-store', custody: f.registry.authority('phone-store') });
        try {
            assert.deepEqual((await reopened.getTransfer(identity, await f.binding('read_chunk', identity))).receipt, committed.receipt);
        }
        finally {
            await reopened.close();
        }
    }
    finally {
        await receiver.close();
        await f.cleanup();
    }
});
for (const point of ['prepare_durable', 'renamed', 'commit_durable'] as const)
    test(`source snapshot ${point} recovery retains no destination receipt`, async () => {
        let once = true;
        const f = await fixture({ localStoreId: 'phone-store', fault: p => {
                if (p === point && once) {
                    once = false;
                    throw new Error('snapshot interruption');
                }
            } });
        try {
            const o = f.offer(), path = join(f.dir, 'source');
            await writeFile(path, 'hello');
            const h = await open(path, 'r');
            try {
                await assert.rejects(async () => f.store.registerSnapshot(o, { handle: h, user_registered: true }, await f.binding('offer', o)), /snapshot interruption/);
            }
            finally {
                await h.close();
            }
            await f.reopen();
            const handle = await f.store.getSnapshot({ version: 1, request_id: o.request_id, asset_id: o.asset.asset_id, asset_version: 1 }, await f.binding('offer', o));
            assert.equal(Buffer.from(await f.store.readSnapshotChunk(handle, 0, await f.binding('offer', o))).toString(), 'hello');
            const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
            try {
                const row = db.prepare('SELECT data FROM transfers_v2').get() as {
                    data: string;
                };
                assert.equal(JSON.parse(row.data).receipt, null);
            }
            finally {
                db.close();
            }
        }
        finally {
            await f.cleanup();
        }
    });
test('different source actors reserve against the same immutable request owner quota', async () => {
    const f = await fixture({ limits: { principal_bytes: 5, principal_files: 1 } });
    try {
        await f.upload(Buffer.from('hello'));
        const other = f.offer(Buffer.from('x'), 'work-output', true), path = join(f.dir, 'output');
        await writeFile(path, 'x');
        const h = await open(path, 'r');
        try {
            await rejects(async () => f.store.registerSnapshot(other, { handle: h, user_registered: true }, await f.binding('offer', other)), 'too_large');
        }
        finally {
            await h.close();
        }
    }
    finally {
        await f.cleanup();
    }
});
test('legacy unproved rows and bytes stay quarantined without releasing dedupe', async () => {
    const f = await fixture();
    try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(f.config.rootDir, { mode: 0o700 });
        const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
        db.exec('CREATE TABLE transfers(id TEXT PRIMARY KEY,identity TEXT UNIQUE,data TEXT)');
        db.prepare('INSERT INTO transfers VALUES(?,?,?)').run('legacy', 'old-key', JSON.stringify({ principal: 'legacy-actor', state: 'committed' }));
        db.close();
        const { chmod, readFile } = await import('node:fs/promises');
        await chmod(join(f.config.rootDir, 'metadata.sqlite'), 0o600);
        await mkdir(join(f.config.rootDir, 'bytes'), { mode: 0o700 });
        await writeFile(join(f.config.rootDir, 'bytes', 'legacy.asset'), 'retained');
        const o = f.offer();
        await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'result_unknown');
        assert.equal((await readFile(join(f.config.rootDir, 'bytes', 'legacy.asset'))).toString(), 'retained');
        const old = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
        try {
            assert.equal((old.prepare('SELECT count(*) AS n FROM transfers').get() as {
                n: number;
            }).n, 1);
            assert.equal((old.prepare('SELECT count(*) AS n FROM transfers_v2').get() as {
                n: number;
            }).n, 0);
        }
        finally {
            old.close();
        }
    }
    finally {
        await f.cleanup();
    }
});
test('source snapshot expiry collection preserves source tombstone without wire receipt', async () => {
    const f = await fixture({ localStoreId: 'phone-store', limits: { asset_ttl_ms: 20 } });
    try {
        const o = f.offer(), path = join(f.dir, 'selection');
        await writeFile(path, 'hello');
        const h = await open(path, 'r');
        try {
            await f.store.registerSnapshot(o, { handle: h, user_registered: true }, await f.binding('offer', o));
        }
        finally {
            await h.close();
        }
        f.setNow(1021);
        const lookup = { version: 1 as const, request_id: o.request_id, asset_id: o.asset.asset_id, asset_version: 1 };
        await f.store.collectSnapshotExpired(lookup, await f.binding('offer', o));
        assert.deepEqual(await readdir(join(f.config.rootDir, 'bytes')), []);
        await f.reopen();
        const reopened = await open(path, 'r');
        try {
            await rejects(async () => f.store.registerSnapshot(o, { handle: reopened, user_registered: true }, await f.binding('offer', o)), 'expired');
        }
        finally {
            await reopened.close();
        }
    }
    finally {
        await f.cleanup();
    }
});
test('current reauthenticated destination pairing reads original custody and receipt', async () => {
    const f = await fixture();
    try {
        const committed = await f.upload(Buffer.from('hello')), identity = f.identity(committed), read = { ...identity, chunk_index: 0 }, old = await f.binding('read_chunk', read);
        f.rotate('mac', 'work-pair-generation-2');
        const current = await f.binding('read_chunk', read);
        assert.equal(current.context.principal_id, 'work-principal');
        assert.equal(current.context.pairing_id, 'work-pair-generation-2');
        assert.equal((await f.store.readChunk(read, current)).data_base64, Buffer.from('hello').toString('base64'));
        assert.deepEqual((await f.store.getTransfer(identity, current)).receipt, committed.receipt);
        await rejects(() => f.store.readChunk(read, old), 'permission_denied');
    }
    finally {
        await f.cleanup();
    }
});
test('ordinary scope regressions reject unregistered slots, another pairing and ambiguous owner request', async () => {
    const f = await fixture();
    try {
        const o = f.offer(), offered = await f.store.offer(o, await f.binding('offer', o)), identity = f.identity(offered), b = await f.binding('commit', identity);
        await rejects(() => f.store.commit(identity, { ...b, context: { ...b.context, pairing_id: 'different-pair' }, lease: { ...b.lease, pairing_id: 'different-pair' } }), 'permission_denied');
        const unknown = { ...o, asset: { ...o.asset, asset_id: 'unregistered' } };
        await rejects(async () => f.store.offer(unknown, await f.binding('offer', unknown)), 'permission_denied');
        f.registry.register(o, 'another-request-owner');
        await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'permission_denied');
    }
    finally {
        await f.cleanup();
    }
});
test('file stat failure closes its opened handle before propagating and permits retry', async () => { let failStat = false, closed = 0; const f = await fixture({ fault: p => { if (p === 'file_stat' && failStat) {
        failStat = false;
        throw new Error('ordinary stat I/O failure');
    } if (p === 'file_closed_on_error')
        closed++; } }); try {
    const receipt = await f.upload(Buffer.from('hello')), read = { ...f.identity(receipt), chunk_index: 0 };
    failStat = true;
    await assert.rejects(async () => f.store.readChunk(read, await f.binding('read_chunk', read)), /ordinary stat I\/O failure/);
    assert.equal(closed, 1);
    assert.equal((await f.store.readChunk(read, await f.binding('read_chunk', read))).data_base64, Buffer.from('hello').toString('base64'));
}
finally {
    await f.cleanup();
} });
test('independent maintenance collects destination at request/custody expiry while actor reads remain expired', async () => { const f = await fixture(); try {
    const o = f.offer(Buffer.from('hello'), 'short-request', false, 1100), offered = await f.store.offer(o, await f.binding('offer', o)), identity = f.identity(offered), chunk = { ...identity, chunk_index: 0, data_base64: Buffer.from('hello').toString('base64') };
    await f.store.putChunk(chunk, await f.binding('put_chunk', chunk));
    await f.store.commit(identity, await f.binding('commit', identity));
    f.setNow(1101);
    const read = { ...identity, chunk_index: 0 };
    await rejects(async () => f.store.readChunk(read, await f.binding('read_chunk', read)), 'expired');
    await f.reopen();
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 1 });
    assert.deepEqual(await readdir(join(f.config.rootDir, 'bytes')), []);
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 0 });
    await rejects(async () => f.store.offer(o, await f.binding('offer', o)), 'expired');
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
    try {
        const row = db.prepare('SELECT data FROM transfers_v2').get() as {
            data: string;
        };
        assert.equal(JSON.parse(row.data).state, 'expired');
        assert.ok(JSON.parse(row.data).receipt);
    }
    finally {
        db.close();
    }
}
finally {
    await f.cleanup();
} });
test('independent maintenance collects expired source snapshot without a destination receipt', async () => { const f = await fixture({ localStoreId: 'phone-store' }); try {
    const o = f.offer(Buffer.from('hello'), 'short-source', false, 1100), path = join(f.dir, 'source');
    await writeFile(path, 'hello');
    const h = await open(path, 'r');
    try {
        await f.store.registerSnapshot(o, { handle: h, user_registered: true }, await f.binding('offer', o));
    }
    finally {
        await h.close();
    }
    const lookup = { version: 1 as const, request_id: o.request_id, asset_id: o.asset.asset_id, asset_version: 1 }, handle = await f.store.getSnapshot(lookup, await f.binding('offer', o));
    f.setNow(1101);
    await rejects(async () => f.store.readSnapshotChunk(handle, 0, await f.binding('offer', o)), 'expired');
    await f.reopen();
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 1 });
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(f.config.rootDir, 'metadata.sqlite'));
    try {
        const row = db.prepare('SELECT data FROM transfers_v2').get() as {
            data: string;
        };
        assert.equal(JSON.parse(row.data).state, 'expired');
        assert.equal(JSON.parse(row.data).receipt, null);
    }
    finally {
        db.close();
    }
}
finally {
    await f.cleanup();
} });
test('maintenance private lease identity, current epoch and bounded batch contract', async () => { const f = await fixture(); try {
    const proof = await f.config.custody.acquireMaintenance('mac-store');
    assert.equal(f.config.custody.currentMaintenance(proof), undefined);
    assert.throws(() => f.config.custody.currentMaintenance({ descriptor: proof.descriptor }), { code: 'permission_denied' });
    f.registry.revokeMaintenance();
    assert.throws(() => f.config.custody.currentMaintenance(proof), { code: 'permission_denied' });
    f.registry.restoreMaintenance();
    assert.throws(() => f.config.custody.currentMaintenance(proof), { code: 'permission_denied' });
    await rejects(() => f.store.collectExpiredMaintenance({ limit: 33 }), 'invalid');
    const o = f.offer(Buffer.from('a'), 'temp-a', false, 1100), b = f.offer(Buffer.from('b'), 'temp-b', false, 1100);
    await f.store.offer(o, await f.binding('offer', o));
    await f.store.offer(b, await f.binding('offer', b));
    f.setNow(1101);
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 1 });
    assert.equal((await readdir(join(f.config.rootDir, 'bytes'))).length, 1);
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 1 });
    assert.deepEqual(await f.store.collectExpiredMaintenance({ limit: 1 }), { collected: 0 });
}
finally {
    await f.cleanup();
} });

test('optional uncached final authority rejects a changed listener before chunk write and receipt return',async()=>{
 const f=await fixture();let listenerCurrent=true,finals=0;
 f.auth.finalCurrent=()=>{finals++;if(!listenerCurrent)throw new MaterialProtocolError('permission_denied');return undefined;};
 try{const bytes=Buffer.from('ordinary final fence'),offer=f.offer(bytes),fact=await f.store.offer(offer,await f.binding('offer',offer)),identity=f.identity(fact),chunk={...identity,chunk_index:0,data_base64:bytes.toString('base64')};
  const binding=await f.binding('put_chunk',chunk);listenerCurrent=false;
  await assert.rejects(f.store.putChunk(chunk,binding),{code:'permission_denied'});
  listenerCurrent=true;assert.deepEqual((await f.store.getTransfer(identity,await f.binding('read_chunk',identity))).received_chunks,[]);
  await f.store.putChunk(chunk,await f.binding('put_chunk',chunk));
  const committed=await f.store.commit(identity,await f.binding('commit',identity));assert.ok(committed.receipt);assert.ok(finals>0);
  let revokeAfter=false;f.auth.after=async()=>{if(revokeAfter)listenerCurrent=false;};revokeAfter=true;
  await assert.rejects(f.store.getTransfer(identity,await f.binding('read_chunk',identity)),{code:'permission_denied'});
 }finally{listenerCurrent=true;await f.cleanup();}
});

test('synchronous after authorizes every captured scope, rejects throw/nonundefined, and retains uncached final enforcement',async()=>{
 const f=await fixture();let synchronous=0,finals=0,deny=false,bad=false;
 f.auth.after=async()=>{throw Error('synchronous authority must not enter the legacy asynchronous port');};
 f.auth.synchronousAfter=(lease,scope)=>{synchronous++;f.auth.current(lease,scope);if(deny)throw new MaterialProtocolError('permission_denied');return (bad?Promise.resolve():undefined)as undefined;};
 f.auth.finalCurrent=(lease,scope)=>{finals++;f.auth.current(lease,scope);if(deny)throw new MaterialProtocolError('permission_denied');return undefined;};
 try{const bytes=Buffer.from('sync after'),offer=f.offer(bytes),fact=await f.store.offer(offer,await f.binding('offer',offer)),identity=f.identity(fact),chunk={...identity,chunk_index:0,data_base64:bytes.toString('base64')};
  bad=true;await assert.rejects(f.store.putChunk(chunk,await f.binding('put_chunk',chunk)),{code:'permission_denied'});bad=false;
  deny=true;await assert.rejects(f.store.putChunk(chunk,await f.binding('put_chunk',chunk)),{code:'permission_denied'});deny=false;
  await f.store.putChunk(chunk,await f.binding('put_chunk',chunk));const committed=await f.store.commit(identity,await f.binding('commit',identity));assert.ok(committed.receipt);assert.ok(synchronous>0);assert.ok(finals>0);
 }finally{bad=false;deny=false;await f.cleanup();}
});
test('legacy asynchronous after still waits and rejects the original lease across revoke then restore',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void,armed=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),start=new Promise<void>(resolve=>{entered=resolve;});
 f.auth.after=async()=>{if(armed){armed=false;entered();await gate;}};
 try{const offer=f.offer();armed=true;const pending=f.store.offer(offer,await f.binding('offer',offer));const rejected=assert.rejects(pending,{code:'permission_denied'});await start;f.revoke();f.restore();release();await rejected;}finally{release();await f.cleanup();}
});

test('local whole asset read keeps exact 4MiB bytes and uses one custody run', async () => {
 const f=await fixture();try{
  const bytes=Buffer.alloc(MATERIAL_LIMITS.file_bytes,71),fact=await f.upload(bytes),input={...f.identity(fact),chunk_index:0};
  let runs=0;const raw=(f.store as any).run.bind(f.store);(f.store as any).run=(...args:any[])=>{runs++;return raw(...args);};
  const read=await f.store.readLocalAsset(input,await f.binding('read_chunk',input));
  assert.deepEqual(read,new Uint8Array(bytes));assert.equal(runs,1);
  const chunk=await f.store.readChunk(input,await f.binding('read_chunk',input));assert.equal(Buffer.from(chunk.data_base64,'base64').length,MATERIAL_LIMITS.chunk_bytes);
 }finally{await f.cleanup();}
});
test('local whole asset read rejects changed bytes and live revocation', async () => {
 let armed=false,revoke:()=>void=()=>{};const f=await fixture({fault:point=>{if(armed&&point==='file_stat')revoke();}});try{
  const bytes=Buffer.alloc(MATERIAL_LIMITS.chunk_bytes+19,4),fact=await f.upload(bytes),input={...f.identity(fact),chunk_index:0};
  const files=await readdir(join(f.config.rootDir,'bytes'));assert.equal(files.length,1);await writeFile(join(f.config.rootDir,'bytes',files[0]),Buffer.alloc(bytes.length,5));
  const binding=await f.binding('read_chunk',input);await rejects(()=>f.store.readLocalAsset(input,binding),'hash_mismatch');
  await writeFile(join(f.config.rootDir,'bytes',files[0]),bytes);revoke=f.revoke;armed=true;
  await rejects(()=>f.store.readLocalAsset(input,binding),'permission_denied');
 }finally{await f.cleanup();}
});

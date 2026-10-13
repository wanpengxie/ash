import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MATERIAL_LIMITS, MaterialProtocolError, type AssetInputs, type AssetOperation, type AssetRef, type TransferFact, type AssetReceipt, type MaterialAuthorization, type MaterialAuthorizationScope, type MaterialTrustedContext } from './material-types';
import type { MaterialCustodyMaintenanceLease, MaterialCustodyAuthority, MaterialCustodyDescriptor, MaterialCustodyLease, MaterialStorageRole, MaterialCustodyPurpose, MaterialSnapshotHandle } from './material-custody';
import { parseAssetEnvelope, sameMaterialEndpoint, parseMaterialEndpoint } from './material-protocol';
type Scope = Extract<MaterialAuthorizationScope, {
    kind: 'request';
    action: AssetOperation;
}>;
export interface MaterialStoreBinding {
    context: MaterialTrustedContext;
    lease: MaterialTrustedContext;
    scope: Scope;
}
export interface MaterialAssetStoreOptions {
    rootDir: string;
    custody: MaterialCustodyAuthority;
    localStoreId: string;
    authorization: MaterialAuthorization;
    clock?: () => number;
    limits?: Partial<{
        [K in keyof Pick<typeof MATERIAL_LIMITS, 'file_bytes' | 'request_bytes' | 'assets' | 'principal_bytes' | 'principal_files' | 'temporary_ttl_ms' | 'asset_ttl_ms'>]: number;
    }>;
    maxMetadataRecords?: number;
    maxMetadataBytes?: number;
    busyMs?: number;
    /** Test-only interruption point; never supplies authority. */
    fault?: (point: 'reserved' | 'chunk_synced' | 'prepare_durable' | 'renamed' | 'commit_durable' | 'ack_durable' | 'file_stat' | 'file_closed_on_error') => void | Promise<void>;
}
interface RunBinding extends MaterialStoreBinding {
    custodyLease: MaterialCustodyLease;
    descriptor: Readonly<MaterialCustodyDescriptor>;
    storageRole: MaterialStorageRole;
}
interface MaintenanceBinding {
    maintenanceLease: MaterialCustodyMaintenanceLease;
    maintenanceDescriptor: Readonly<MaterialCustodyMaintenanceLease['descriptor']>;
}
type IoBinding = RunBinding | MaintenanceBinding;
interface RecordData {
    custody: MaterialCustodyDescriptor;
    storage_role: MaterialStorageRole;
    offer: AssetInputs['offer'];
    principal: string;
    pairing: string;
    grant_revision: string;
    authorization_epoch: string;
    scope: Scope;
    transfer_id: string;
    state: TransferFact['state'];
    expires_at: number;
    chunks: Record<string, string>;
    receipt: AssetReceipt | null;
    file: string;
    inode: string;
    device: string;
    snapshot_prepare?: {
        inode: string;
        device: string;
        sha256: string;
        length: number;
    };
    prepare?: {
        inode: string;
        device: string;
        sha256: string;
        length: number;
        receipt: AssetReceipt;
    };
}
const fail = (code: ConstructorParameters<typeof MaterialProtocolError>[0]): never => { throw new MaterialProtocolError(code); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
const freeze = <T>(v: T): T => {
    if (v && typeof v === 'object') {
        for (const child of Object.values(v))
            freeze(child);
        Object.freeze(v);
    }
    return v;
};
/** SQLite FULL-sync metadata and individually fsynced controlled files. No business calls. */
export class MaterialAssetStore {
    readonly limits: typeof MATERIAL_LIMITS;
    private readonly root: string;
    private readonly clock: () => number;
    private db?: DatabaseSync;
    private init?: Promise<void>;
    private directoryIdentity?: string;
    private metadataIdentity?: string;
    private closing = false;
    private snapshots = new WeakMap<object, {
        custody_id: string;
        local_store_id: string;
        snapshot_id: string;
    }>();
    private active = new Set<Promise<unknown>>();
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly options: MaterialAssetStoreOptions) {
        this.options = Object.freeze({ ...options, limits: Object.freeze({ ...options.limits }) });
        if (!options.custody || typeof options.custody.acquire !== 'function' || typeof options.custody.current !== 'function' || typeof options.custody.acquireMaintenance !== 'function' || typeof options.custody.currentMaintenance !== 'function' || !options.localStoreId || Buffer.byteLength(options.localStoreId) > MATERIAL_LIMITS.id_bytes)
            fail('invalid');
        this.root = resolve(options.rootDir);
        if (!Number.isSafeInteger(options.busyMs ?? 250) || (options.busyMs ?? 250) < 0 || (options.busyMs ?? 250) > 1000)
            fail('invalid');
        this.clock = options.clock ?? Date.now;
        const limits = { ...MATERIAL_LIMITS };
        const allowedLimitKeys = ['file_bytes', 'request_bytes', 'assets', 'principal_bytes', 'principal_files', 'temporary_ttl_ms', 'asset_ttl_ms'] as const;
        const overrides = options.limits ?? {};
        for (const key of Reflect.ownKeys(overrides)) {
            if (typeof key !== 'string')
                throw new MaterialProtocolError('invalid');
            if (!allowedLimitKeys.some(allowed => allowed === key) || !Object.hasOwn(overrides, key) || !Object.hasOwn(MATERIAL_LIMITS, key))
                fail('invalid');
            const value = (overrides as Record<string, number>)[key];
            if (!Number.isSafeInteger(value) || value < 0 || value > MATERIAL_LIMITS[key as keyof typeof MATERIAL_LIMITS])
                fail('invalid');
            (limits as Record<string, number>)[key] = value;
        }
        this.limits = Object.freeze(limits);
        if (!Number.isSafeInteger(options.maxMetadataBytes ?? 32 * 1024 * 1024) || (options.maxMetadataBytes ?? 32 * 1024 * 1024) < 1 || (options.maxMetadataBytes ?? 32 * 1024 * 1024) > 32 * 1024 * 1024)
            fail('invalid');
        if (!Number.isSafeInteger(options.maxMetadataRecords ?? 4096) || (options.maxMetadataRecords ?? 4096) < 1 || (options.maxMetadataRecords ?? 4096) > 4096)
            fail('invalid');
    }
    private async initialize(binding: IoBinding) {
        await this.io(binding, () => mkdir(this.root, { recursive: true, mode: 0o700 }));
        if (await this.io(binding, () => realpath(this.root)) !== this.root)
            fail('permission_denied');
        const dir = await this.io(binding, () => lstat(this.root, { bigint: true }));
        if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 63n) !== 0n)
            fail('permission_denied');
        await this.io(binding, () => mkdir(join(this.root, 'bytes'), { recursive: true, mode: 0o700 }));
        const bytes = await this.io(binding, () => lstat(join(this.root, 'bytes'), { bigint: true }));
        if (!bytes.isDirectory() || bytes.isSymbolicLink() || (bytes.mode & 63n) !== 0n)
            fail('permission_denied');
        this.directoryIdentity = `${dir.dev}:${dir.ino}:${bytes.dev}:${bytes.ino}`;
        const metadata = join(this.root, 'metadata.sqlite');
        const handle = await this.openHandle(metadata, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600, binding);
        try {
            const stat = await this.io(binding, () => handle.stat({ bigint: true }));
            if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 63n) !== 0n)
                fail('permission_denied');
            this.metadataIdentity = `${stat.dev}:${stat.ino}`;
            await this.io(binding, () => handle.sync());
        }
        finally {
            await this.cleanup(handle, binding);
        }
        this.current(binding);
        const db = new DatabaseSync(metadata);
        try {
            db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA max_page_count=16384; CREATE TABLE IF NOT EXISTS transfers_v2 (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, data TEXT NOT NULL); PRAGMA user_version=2');
        }
        catch (error) {
            db.close();
            if (String(error).includes('locked') || String(error).includes('busy'))
                fail('offline');
            throw error;
        }
        this.current(binding);
        this.db = db;
        const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transfers'").get();
        if (legacy && Number((db.prepare('SELECT COUNT(*) AS count FROM transfers').get() as {
            count: number;
        }).count) > 0) {
            db.close();
            this.db = undefined;
            fail('result_unknown');
        }
        await this.syncDir(this.root, binding);
    }
    private async checkDirectories(binding: IoBinding) {
        const [root, bytes, metadata] = await this.io(binding, () => Promise.all([lstat(this.root, { bigint: true }), lstat(join(this.root, 'bytes'), { bigint: true }), lstat(join(this.root, 'metadata.sqlite'), { bigint: true })]));
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 63n) !== 0n || metadata.nlink !== 1n || `${metadata.dev}:${metadata.ino}` !== this.metadataIdentity)
            fail('permission_denied');
        if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 63n) !== 0n || !bytes.isDirectory() || bytes.isSymbolicLink() || (bytes.mode & 63n) !== 0n || `${root.dev}:${root.ino}:${bytes.dev}:${bytes.ino}` !== this.directoryIdentity)
            fail('permission_denied');
    }
    private async io<T>(binding: IoBinding, fn: () => Promise<T>): Promise<T> {
        this.current(binding);
        const result = await fn();
        {const after=this.after(binding);if(after!==undefined)await after;}
        this.current(binding);
        return result;
    }
    private final(binding:IoBinding):void {
        this.current(binding);
        if ('maintenanceLease' in binding) return;
        if (this.options.authorization.finalCurrent?.(binding.lease,binding.scope)!==undefined) fail('permission_denied');
    }
    private async openHandle(path: string, flags: number, mode: number | undefined, binding: IoBinding): Promise<FileHandle> {
        this.current(binding);
        let handle: FileHandle | undefined;
        try {
            if(flags & constants.O_CREAT)this.final(binding);
            handle = await open(path, flags, mode);
            {const after=this.after(binding);if(after!==undefined)await after;}
            this.current(binding);
            return handle;
        }
        catch (error) {
            if (handle)
                await handle.close();
            {const after=this.after(binding);if(after!==undefined)await after;}
            this.current(binding);
            throw error;
        }
    }
    private async cleanup(handle: FileHandle, binding: IoBinding): Promise<void> {
        let before: unknown;
        try {
            this.current(binding);
        }
        catch (error) {
            before = error;
        }
        try {
            await handle.close();
        }
        finally {
            {const after=this.after(binding);if(after!==undefined)await after;}
            this.current(binding);
        }
        if (before)
            throw before;
    }
    private validate(binding: MaterialStoreBinding, operation: AssetOperation, input: AssetInputs[AssetOperation]) {
        const s = binding.scope, c = binding.context, l = binding.lease;
        for (const id of [c.principal_id, c.pairing_id, c.grant_revision, c.authorization_epoch])
            if (typeof id !== 'string' || !id || Buffer.byteLength(id) > MATERIAL_LIMITS.id_bytes)
                fail('invalid');
        if (s.kind !== 'request' || s.action !== operation || !s.transfer || s.request_id !== input.request_id || c.principal_id !== l.principal_id || c.pairing_id !== l.pairing_id || c.grant_revision !== l.grant_revision || c.authorization_epoch !== l.authorization_epoch || !sameMaterialEndpoint(c.source_binding, l.source_binding) || this.clock() >= Math.min(c.expires_at, l.expires_at))
            fail('permission_denied');
        const asset = 'asset' in input ? input.asset : { asset_id: input.asset_id, version: input.asset_version };
        if (s.transfer.asset_id !== asset.asset_id || s.transfer.asset_version !== asset.version)
            fail('permission_denied');
        if ('asset' in input && (!sameMaterialEndpoint(s.transfer.source, input.source) || !sameMaterialEndpoint(s.transfer.destination, input.destination)))
            fail('permission_denied');
        // The connecting actor must be one exact end of this explicitly authorized transfer.
        const actor = operation === 'read_chunk' || operation === 'ack' ? s.transfer.destination : s.transfer.source;
        if (!sameMaterialEndpoint(c.source_binding, actor))
            fail('permission_denied');
        this.options.authorization.current(l, s);
    }
    private afterActor(binding: MaterialStoreBinding): Promise<void>|undefined {
        if (this.options.authorization.synchronousAfter) {
            if (this.options.authorization.synchronousAfter(binding.lease,binding.scope)!==undefined) fail('permission_denied');
            this.options.authorization.current(binding.lease,binding.scope);
            return undefined;
        }
        return this.options.authorization.after(binding.lease,binding.scope).then(()=>{this.options.authorization.current(binding.lease,binding.scope);});
    }
    private after(binding: IoBinding): Promise<void>|undefined {
        if ('maintenanceLease' in binding) {
            this.options.custody.currentMaintenance(binding.maintenanceLease);
            this.current(binding);
            return Promise.resolve();
        }
        const after=this.afterActor(binding);
        if(after!==undefined)return after.then(()=>{this.current(binding);});
        this.current(binding);
        return undefined;
    }
    private current(binding: IoBinding) {
        if ('maintenanceLease' in binding) {
            this.options.custody.currentMaintenance(binding.maintenanceLease);
            if (this.clock() >= binding.maintenanceDescriptor.expires_at)
                fail('expired');
            return;
        }
        this.options.authorization.current(binding.lease, binding.scope);
        this.options.custody.current(binding.custodyLease);
        if (this.clock() >= binding.descriptor.expires_at)
            fail('expired');
    }
    private run<T>(original: MaterialStoreBinding, operation: AssetOperation, input: AssetInputs[AssetOperation], fn: (snapshotBinding: RunBinding) => Promise<T>, storageRole: MaterialStorageRole = 'destination_transfer', purpose: MaterialCustodyPurpose = 'wire'): Promise<T> {
        const actorBinding = freeze(clone(original));
        input = freeze(clone(input));
        if (this.closing) {
            this.options.authorization.current(actorBinding.lease, actorBinding.scope);
            return Promise.reject(new MaterialProtocolError('offline'));
        }
        const task = this.tail.catch(() => { }).then(async () => {
            let transaction = false, binding: RunBinding | undefined;
            try {
                this.validate(actorBinding, operation, input);
                this.options.authorization.current(actorBinding.lease, actorBinding.scope);
                const custodyLease = await this.options.custody.acquire(actorBinding.context, actorBinding.scope, storageRole, purpose);
                this.options.authorization.current(actorBinding.lease, actorBinding.scope);
                this.options.custody.current(custodyLease);
                {const after=this.afterActor(actorBinding);if(after!==undefined)await after;}
                this.options.authorization.current(actorBinding.lease, actorBinding.scope);
                this.options.custody.current(custodyLease);
                const descriptor = freeze(clone(custodyLease.descriptor));
                const descriptorKeys = ['version', 'custody_id', 'authority_id', 'owner_principal_id', 'request_id', 'asset_id', 'asset_version', 'sha256', 'byte_length', 'source', 'destination', 'local_store_id', 'expires_at'];
                if (!descriptor || typeof descriptor !== 'object' || Object.keys(descriptor).some(key => !descriptorKeys.includes(key)) || descriptorKeys.some(key => !Object.hasOwn(descriptor, key)))
                    fail('invalid');
                parseMaterialEndpoint(descriptor.source);
                parseMaterialEndpoint(descriptor.destination);
                if (descriptor.expires_at > Math.min(actorBinding.context.expires_at, actorBinding.lease.expires_at) || ('asset' in input && descriptor.expires_at > Math.min(input.expires_at, input.asset.expires_at)))
                    fail('invalid');
                if (!Number.isSafeInteger(descriptor.expires_at) || descriptor.expires_at < 1 || !Number.isSafeInteger(descriptor.byte_length) || descriptor.byte_length < 0 || descriptor.byte_length > this.limits.file_bytes || typeof descriptor.sha256 !== 'string' || !/^([a-f0-9]{64})$/.test(descriptor.sha256))
                    fail('invalid');
                const asset = 'asset' in input ? input.asset : { asset_id: input.asset_id, version: input.asset_version };
                if (descriptor.version !== 1 || descriptor.local_store_id !== this.options.localStoreId || descriptor.request_id !== input.request_id || descriptor.asset_id !== asset.asset_id || descriptor.asset_version !== asset.version || !sameMaterialEndpoint(descriptor.source, actorBinding.scope.transfer.source) || !sameMaterialEndpoint(descriptor.destination, actorBinding.scope.transfer.destination))
                    fail('permission_denied');
                if ('asset' in input && (descriptor.sha256 !== input.asset.sha256 || descriptor.byte_length !== input.asset.byte_length))
                    fail('conflict');
                for (const id of [descriptor.custody_id, descriptor.authority_id, descriptor.owner_principal_id, descriptor.local_store_id])
                    if (typeof id !== 'string' || !id || Buffer.byteLength(id) > MATERIAL_LIMITS.id_bytes)
                        fail('invalid');
                binding = { ...actorBinding, custodyLease, descriptor, storageRole };
                this.current(binding);
                await this.io(binding, async () => {
                    try {
                        await (this.init ??= this.initialize(binding!));
                    }
                    catch (error) {
                        this.init = undefined;
                        throw error;
                    }
                    await this.checkDirectories(binding!);
                });
                const until = Date.now() + (this.options.busyMs ?? 250);
                for (;;) {
                    try {
                        this.current(binding);
                        this.db!.exec('BEGIN IMMEDIATE');
                        transaction = true;
                        break;
                    }
                    catch (error) {
                        if (!String(error).includes('locked') && !String(error).includes('busy'))
                            throw error;
                        if (Date.now() >= until)
                            fail('offline');
                        await this.io(binding, () => new Promise<void>(r => setTimeout(r, 5)));
                    }
                }
                this.current(binding);
                const result = await fn(binding);
                await this.io(binding, () => this.checkDirectories(binding!));
                this.final(binding);
                this.db!.exec('COMMIT');
                transaction = false;
                this.current(binding);
                {const after=this.after(binding);if(after!==undefined)await after;}
                this.current(binding);
                const output = clone(result);
                if (storageRole === 'source_snapshot' && output && typeof output === 'object' && 'kind' in output && output.kind === 'source_snapshot') {
                    const handle = output as unknown as MaterialSnapshotHandle;
                    Object.freeze(handle);
                    this.snapshots.set(handle, { custody_id: descriptor.custody_id, local_store_id: descriptor.local_store_id, snapshot_id: handle.snapshot_id });
                }
                this.final(binding);
                return output;
            }
            catch (error) {
                if (transaction) {
                    try {
                        this.db!.exec('ROLLBACK');
                    }
                    catch { }
                }
                {const after=this.afterActor(actorBinding);if(after!==undefined)await after;}
                this.options.authorization.current(actorBinding.lease, actorBinding.scope);
                if (binding)
                    this.final(binding);
                throw error;
            }
        });
        this.tail = task;
        this.active.add(task);
        void task.finally(() => this.active.delete(task)).catch(() => { });
        return task;
    }
    private identity(custody: MaterialCustodyDescriptor, role: MaterialStorageRole) { return digest(Buffer.from(JSON.stringify([custody.authority_id, custody.owner_principal_id, custody.request_id, custody.asset_id, custody.asset_version, custody.source, custody.destination, role]))); }
    private all(): RecordData[] {
        return (this.db!.prepare('SELECT data FROM transfers_v2').all() as {
            data: string;
        }[]).map(r => JSON.parse(r.data));
    }
    private save(record: RecordData) {
        const serialized = JSON.stringify(record);
        const total = (this.db!.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS size FROM transfers_v2 WHERE id<>?').get(record.transfer_id) as {
            size: number;
        }).size;
        if (Buffer.byteLength(serialized) > 128 * 1024 || total + Buffer.byteLength(serialized) > (this.options.maxMetadataBytes ?? 32 * 1024 * 1024))
            fail('too_large');
        this.db!.prepare('INSERT INTO transfers_v2(id,identity,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.transfer_id, this.identity(record.custody, record.storage_role), serialized);
    }
    private async durable(record: RecordData, binding: RunBinding) {
        this.final(binding);
        this.save(record);
        this.final(binding);
        this.db!.exec('COMMIT');
        this.current(binding);
        const until = Date.now() + (this.options.busyMs ?? 250);
        for (;;) {
            try {
                this.current(binding);
                this.db!.exec('BEGIN IMMEDIATE');
                this.current(binding);
                return;
            }
            catch (error) {
                if (!String(error).includes('locked') && !String(error).includes('busy'))
                    throw error;
                if (Date.now() >= until)
                    fail('offline');
                await this.io(binding, () => new Promise<void>(r => setTimeout(r, 5)));
            }
        }
    }
    private fact(r: RecordData): TransferFact {
        if (r.storage_role !== 'destination_transfer')
            fail('permission_denied');
        return { version: 1, transfer_id: r.transfer_id, request_id: r.offer.request_id, asset_id: r.offer.asset.asset_id, asset_version: r.offer.asset.version, state: r.state, received_chunks: Object.keys(r.chunks).map(Number).sort((a, b) => a - b), receipt: r.receipt, expires_at: r.expires_at };
    }
    private load(input: AssetInputs['commit'], binding: RunBinding): RecordData {
        const row = this.db!.prepare('SELECT data FROM transfers_v2 WHERE id=?').get(input.transfer_id) as {
            data: string;
        } | undefined;
        if (!row)
            fail('not_found');
        const r: RecordData = JSON.parse(row!.data);
        const s = binding.scope;
        if (JSON.stringify(r.custody) !== JSON.stringify(binding.descriptor) || r.storage_role !== binding.storageRole || r.offer.request_id !== input.request_id || r.offer.asset.asset_id !== input.asset_id || r.offer.asset.version !== input.asset_version || !sameMaterialEndpoint(r.scope.source, s.source) || !sameMaterialEndpoint(r.scope.return_to, s.return_to) || !sameMaterialEndpoint(r.scope.target, s.target) || !sameMaterialEndpoint(r.offer.source, s.transfer.source) || !sameMaterialEndpoint(r.offer.destination, s.transfer.destination))
            fail('permission_denied');
        if (r.state === 'expired' || this.clock() >= r.expires_at)
            fail('expired');
        if (r.state === 'failed')
            fail('hash_mismatch');
        if (r.state === 'unknown')
            fail('result_unknown');
        return r;
    }
    private path(r: RecordData, committed = false) { if (!/^[a-f0-9-]{36}$/.test(r.file))
        fail('result_unknown'); return join(this.root, 'bytes', `${r.file}.${committed ? 'asset' : 'part'}`); }
    private async syncDir(path: string, binding: IoBinding) {
        const h = await this.openHandle(path, constants.O_RDONLY | constants.O_NOFOLLOW, undefined, binding);
        try {
            await this.io(binding, () => h.sync());
        }
        finally {
            await this.cleanup(h, binding);
        }
    }
    private async file(r: RecordData, binding: IoBinding, committed = false, write = false): Promise<FileHandle> {
        const h = await this.openHandle(this.path(r, committed), (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW, undefined, binding);
        try {
            await this.io(binding, async () => { await this.options.fault?.('file_stat'); });
            const stat = await this.io(binding, () => h.stat({ bigint: true }));
            if (!stat.isFile() || stat.nlink !== 1n || stat.ino.toString() !== r.inode || stat.dev.toString() !== r.device)
                fail('permission_denied');
            this.current(binding);
            return h;
        }
        catch (error) {
            await this.cleanup(h, binding);
            if (h.fd !== -1)
                fail('offline');
            await this.io(binding, async () => { await this.options.fault?.('file_closed_on_error'); });
            this.current(binding);
            throw error;
        }
    }
    private async fault(point: Parameters<NonNullable<MaterialAssetStoreOptions['fault']>>[0], b: RunBinding) { await this.io(b, async () => { await this.options.fault?.(point); }); }
    private reserve(input: AssetInputs['offer'], b: RunBinding): RecordData | undefined {
        const all = this.all(), identity = this.identity(b.descriptor, b.storageRole);
        if (all.some(r => r.custody.authority_id === b.descriptor.authority_id && r.custody.owner_principal_id === b.descriptor.owner_principal_id && r.offer.asset.asset_id === input.asset.asset_id && r.offer.asset.version === input.asset.version && (r.offer.asset.sha256 !== input.asset.sha256 || r.offer.asset.byte_length !== input.asset.byte_length)))
            fail('conflict');
        const previous = all.find(r => this.identity(r.custody, r.storage_role) === identity);
        if (previous) {
            if (JSON.stringify(previous.offer) !== JSON.stringify(input) || JSON.stringify(previous.custody) !== JSON.stringify(b.descriptor) || previous.storage_role !== b.storageRole || !sameMaterialEndpoint(previous.scope.source, b.scope.source) || !sameMaterialEndpoint(previous.scope.return_to, b.scope.return_to) || !sameMaterialEndpoint(previous.scope.target, b.scope.target))
                fail('conflict');
            if (previous.state === 'expired' || this.clock() >= previous.expires_at)
                fail('expired');
            return previous;
        }
        if (all.length >= (this.options.maxMetadataRecords ?? 4096) || input.asset.byte_length > this.limits.file_bytes)
            fail('too_large');
        const live = all.filter(r => r.state !== 'expired');
        const principal = live.filter(r => r.custody.authority_id === b.descriptor.authority_id && r.custody.owner_principal_id === b.descriptor.owner_principal_id), request = principal.filter(r => r.offer.request_id === input.request_id);
        if (principal.length >= this.limits.principal_files || principal.reduce((n, r) => n + r.offer.asset.byte_length, 0) + input.asset.byte_length > this.limits.principal_bytes || request.length >= this.limits.assets || request.reduce((n, r) => n + r.offer.asset.byte_length, 0) + input.asset.byte_length > this.limits.request_bytes)
            fail('too_large');
        return undefined;
    }
    offer(input: AssetInputs['offer'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('offer', input);
        return this.run(binding, 'offer', input, async (binding) => {
            const previous = this.reserve(input, binding);
            if (previous) {
                await this.recover(previous, binding);
                return this.fact(previous);
            }
            const now = this.clock(), expires = Math.min(input.expires_at, input.asset.expires_at, binding.lease.expires_at, binding.descriptor.expires_at, now + this.limits.temporary_ttl_ms);
            if (expires <= now)
                fail('expired');
            const r: RecordData = { custody: clone(binding.descriptor), storage_role: binding.storageRole, offer: clone(input), principal: binding.context.principal_id, pairing: binding.context.pairing_id, grant_revision: binding.lease.grant_revision, authorization_epoch: binding.lease.authorization_epoch, scope: clone(binding.scope), transfer_id: randomUUID(), state: 'offered', expires_at: expires, chunks: {}, receipt: null, file: randomUUID(), inode: '', device: '' };
            // Reservation precedes creation and survives process interruption. Missing proof stays unknown.
            r.state = 'unknown';
            await this.durable(r, binding);
            await this.fault('reserved', binding);
            await this.io(binding, async () => {
                const h = await this.openHandle(this.path(r), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600, binding);
                try {
                    const s = await this.io(binding, () => h.stat({ bigint: true }));
                    r.inode = s.ino.toString();
                    r.device = s.dev.toString();
                    await this.io(binding, () => h.sync());
                }
                finally {
                    await this.cleanup(h, binding);
                }
                await this.syncDir(join(this.root, 'bytes'), binding);
            });
            r.state = 'offered';
            this.save(r);
            return this.fact(r);
        });
    }
    /** Protected input-reader/probe port: locate the existing destination by stable custody, never offer or allocate it. */
    inspectDestination(input:AssetInputs['offer'],binding:MaterialStoreBinding):Promise<TransferFact>{input=parseAssetEnvelope('offer',input);return this.run(binding,'read_chunk',input,async binding=>{const row=this.db!.prepare('SELECT data FROM transfers_v2 WHERE identity=?').get(this.identity(binding.descriptor,'destination_transfer')) as {data:string}|undefined;if(!row)fail('not_found');const stored:RecordData=JSON.parse(row!.data),identity={version:1 as const,request_id:input.request_id,transfer_id:stored.transfer_id,asset_id:input.asset.asset_id,asset_version:input.asset.version},record=this.load(identity,binding);if(JSON.stringify(record.offer.asset)!==JSON.stringify(input.asset)||!sameMaterialEndpoint(record.offer.source,input.source)||!sameMaterialEndpoint(record.offer.destination,input.destination))fail('conflict');await this.recover(record,binding);if(!record.receipt||!['committed','acknowledged'].includes(record.state))fail('result_unknown');await this.verify(record,true,binding);return this.fact(record);});}
    getTransfer(input: AssetInputs['commit'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('commit', input);
        return this.run(binding, binding.scope.action, input, async (binding) => { const r = this.load(input, binding); await this.recover(r, binding); return this.fact(r); });
    }
    putChunk(input: AssetInputs['put_chunk'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('put_chunk', input);
        return this.run(binding, 'put_chunk', input, async (binding) => {
            const r = this.load(input, binding);
            await this.recover(r, binding);
            const bytes = Buffer.from(input.data_base64, 'base64'), offset = input.chunk_index * MATERIAL_LIMITS.chunk_bytes;
            const expected = Math.min(MATERIAL_LIMITS.chunk_bytes, r.offer.asset.byte_length - offset);
            if (expected <= 0 || bytes.length !== expected)
                fail('invalid');
            const hash = digest(bytes), prior = r.chunks[input.chunk_index];
            if (prior) {
                if (prior !== hash)
                    fail('conflict');
                return this.fact(r);
            }
            if (r.state === 'committed' || r.state === 'acknowledged')
                fail('conflict');
            await this.io(binding, async () => {
                const h = await this.file(r, binding, false, true);
                try {
                    let written = 0;
                    while (written < bytes.length) {
                        const n = await this.io(binding, () => {this.final(binding);return h.write(bytes, written, bytes.length - written, offset + written);});
                        if (!n.bytesWritten)
                            fail('offline');
                        written += n.bytesWritten;
                    }
                    await this.io(binding, () => h.sync());
                }
                finally {
                    await this.cleanup(h, binding);
                }
            });
            await this.fault('chunk_synced', binding);
            r.chunks[input.chunk_index] = hash;
            r.state = 'receiving';
            this.save(r);
            return this.fact(r);
        });
    }
    private async verify(r: RecordData, committed: boolean, b: RunBinding) {
        return this.io(b, async () => {
            const h = await this.file(r, b, committed);
            try {
                const s = await this.io(b, () => h.stat());
                if (s.size !== r.offer.asset.byte_length)
                    fail('hash_mismatch');
                const hash = createHash('sha256'), buffer = Buffer.alloc(MATERIAL_LIMITS.chunk_bytes);
                let offset = 0;
                while (offset < s.size) {
                    const { bytesRead } = await this.io(b, () => h.read(buffer, 0, Math.min(buffer.length, s.size - offset), offset));
                    if (!bytesRead)
                        fail('hash_mismatch');
                    hash.update(buffer.subarray(0, bytesRead));
                    offset += bytesRead;
                }
                if (hash.digest('hex') !== r.offer.asset.sha256)
                    fail('hash_mismatch');
                const end = await this.io(b, () => h.stat());
                if (end.size !== s.size || end.mtimeMs !== s.mtimeMs || end.ctimeMs !== s.ctimeMs || end.nlink !== 1)
                    fail('permission_denied');
                await this.io(b, () => h.sync());
            }
            finally {
                await this.cleanup(h, b);
            }
        });
    }
    private async assertRename(r: RecordData, binding: RunBinding) {
        const stage = await this.io(binding, () => lstat(this.path(r), { bigint: true }));
        if (!stage.isFile() || stage.nlink !== 1n || stage.ino.toString() !== r.inode || stage.dev.toString() !== r.device)
            fail('permission_denied');
        try {
            await this.io(binding, () => lstat(this.path(r, true)));
            fail('permission_denied');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
    }
    private async recover(r: RecordData, b: RunBinding) {
        if (r.storage_role === 'source_snapshot' && r.snapshot_prepare) {
            try {
                let committed = false;
                try {
                    await this.io(b, () => lstat(this.path(r, true)));
                    committed = true;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                await this.verify(r, committed, b);
                if (!committed)
                    await this.io(b, async () => { await this.assertRename(r, b); await this.io(b, () => {this.final(b);return rename(this.path(r), this.path(r, true));}); await this.syncDir(join(this.root, 'bytes'), b); });
                r.state = 'committed';
                r.receipt = null;
                delete r.snapshot_prepare;
                await this.durable(r, b);
                return;
            }
            catch (error) {
                if (error instanceof MaterialProtocolError && ['permission_denied', 'expired'].includes(error.code))
                    throw error;
                r.state = 'unknown';
                await this.durable(r, b);
                fail('result_unknown');
            }
        }
        if (!r.prepare)
            return;
        // Only a durable pre-rename inode + hash + length proof can finish a rename gap.
        try {
            let committed = false;
            try {
                await this.io(b, () => lstat(this.path(r, true)));
                committed = true;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            await this.verify(r, committed, b);
            if (!committed)
                await this.io(b, async () => { await this.assertRename(r, b); await this.io(b, () => {this.final(b);return rename(this.path(r), this.path(r, true));}); await this.syncDir(join(this.root, 'bytes'), b); });
            r.receipt = r.prepare.receipt;
            r.state = 'committed';
            r.expires_at = Math.min(r.offer.expires_at, r.offer.asset.expires_at, b.lease.expires_at, b.descriptor.expires_at, r.receipt.received_at + this.limits.asset_ttl_ms);
            delete r.prepare;
            await this.durable(r, b);
        }
        catch (error) {
            if (error instanceof MaterialProtocolError && ['permission_denied', 'expired'].includes(error.code))
                throw error;
            r.state = 'unknown';
            await this.durable(r, b);
            fail('result_unknown');
        }
    }
    commit(input: AssetInputs['commit'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('commit', input);
        return this.run(binding, 'commit', input, async (binding) => {
            const r = this.load(input, binding);
            await this.recover(r, binding);
            if (r.receipt)
                return this.fact(r);
            if (Object.keys(r.chunks).length !== Math.ceil(r.offer.asset.byte_length / MATERIAL_LIMITS.chunk_bytes))
                fail('conflict');
            try {
                await this.verify(r, false, binding);
            }
            catch (error) {
                if (error instanceof MaterialProtocolError && error.code === 'hash_mismatch') {
                    r.state = 'failed';
                    await this.durable(r, binding);
                }
                throw error;
            }
            const receipt: AssetReceipt = { version: 1, receipt_id: randomUUID(), transfer_id: r.transfer_id, request_id: r.offer.request_id, asset_id: r.offer.asset.asset_id, asset_version: r.offer.asset.version, sha256: r.offer.asset.sha256, byte_length: r.offer.asset.byte_length, destination: r.offer.destination, received_at: this.clock() };
            r.prepare = { inode: r.inode, device: r.device, sha256: r.offer.asset.sha256, length: r.offer.asset.byte_length, receipt };
            await this.durable(r, binding);
            await this.fault('prepare_durable', binding);
            await this.io(binding, async () => { await this.assertRename(r, binding); await this.io(binding, () => {this.final(binding);return rename(this.path(r), this.path(r, true));}); await this.syncDir(join(this.root, 'bytes'), binding); });
            await this.fault('renamed', binding);
            r.receipt = receipt;
            r.state = 'committed';
            r.expires_at = Math.min(r.offer.expires_at, r.offer.asset.expires_at, binding.lease.expires_at, binding.descriptor.expires_at, receipt.received_at + this.limits.asset_ttl_ms);
            delete r.prepare;
            await this.durable(r, binding);
            await this.fault('commit_durable', binding);
            return this.fact(r);
        });
    }
    /** Private local input preparation; the wire read_chunk contract remains chunked. */
    readLocalAsset(input: AssetInputs['read_chunk'], binding: MaterialStoreBinding): Promise<Uint8Array> {
        input = parseAssetEnvelope('read_chunk', input);
        if (input.chunk_index !== 0) fail('invalid');
        return this.run(binding, 'read_chunk', input, async binding => {
            const r = this.load(input, binding);
            await this.recover(r, binding);
            if (!r.receipt || !['committed','acknowledged'].includes(r.state)) fail('conflict');
            const length = r.offer.asset.byte_length;
            if (length > MATERIAL_LIMITS.file_bytes || length > this.limits.file_bytes) fail('too_large');
            const h = await this.file(r, binding, true);
            try {
                const before = await this.io(binding, () => h.stat({bigint:true}));
                if (before.size !== BigInt(length)) fail('hash_mismatch');
                const bytes = Buffer.alloc(length);
                let offset = 0;
                while (offset < length) {
                    const result = await this.io(binding, () => h.read(bytes, offset, length-offset, offset));
                    if (!result.bytesRead) fail('hash_mismatch');
                    offset += result.bytesRead;
                }
                if (digest(bytes) !== r.offer.asset.sha256) fail('hash_mismatch');
                const after = await this.io(binding, () => h.stat({bigint:true}));
                if (!after.isFile() || after.nlink !== 1n || after.ino !== before.ino || after.dev !== before.dev ||
                    after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
                    fail('permission_denied');
                this.final(binding);
                return new Uint8Array(bytes);
            } finally { await this.cleanup(h, binding); }
        });
    }
    readChunk(input: AssetInputs['read_chunk'], binding: MaterialStoreBinding): Promise<AssetInputs['put_chunk']> {
        input = parseAssetEnvelope('read_chunk', input);
        return this.run(binding, 'read_chunk', input, async (binding) => {
            const r = this.load(input, binding);
            await this.recover(r, binding);
            if (!r.receipt)
                fail('conflict');
            const offset = input.chunk_index * MATERIAL_LIMITS.chunk_bytes, len = Math.min(MATERIAL_LIMITS.chunk_bytes, r.offer.asset.byte_length - offset);
            if (len <= 0)
                fail('invalid');
            const bytes = await this.io(binding, async () => {
                const h = await this.file(r, binding, true);
                try {
                    const out = Buffer.alloc(len);
                    let count = 0;
                    while (count < len) {
                        const got = await this.io(binding, () => h.read(out, count, len - count, offset + count));
                        if (!got.bytesRead)
                            fail('hash_mismatch');
                        count += got.bytesRead;
                    }
                    if (digest(out) !== r.chunks[input.chunk_index])
                        fail('hash_mismatch');
                    return out;
                }
                finally {
                    await this.cleanup(h, binding);
                }
            });
            return { ...input, data_base64: bytes.toString('base64') };
        });
    }
    ack(input: AssetInputs['ack'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('ack', input);
        return this.run(binding, 'ack', input, async (binding) => {
            const r = this.load(input, binding);
            await this.recover(r, binding);
            if (!r.receipt || r.receipt.receipt_id !== input.receipt_id)
                fail('conflict');
            r.state = 'acknowledged';
            await this.durable(r, binding);
            await this.fault('ack_durable', binding);
            return this.fact(r);
        });
    }
    /** Explicit user-registered, already-open regular single-link handle only. Never accepts a path. */
    async registerSnapshot(input: AssetInputs['offer'], source: {
        handle: FileHandle;
        user_registered: true;
    }, binding: MaterialStoreBinding): Promise<AssetRef> {
        if (source.user_registered !== true)
            fail('permission_denied');
        input = parseAssetEnvelope('offer', input);
        const sourceHandle = source.handle;
        return this.run(binding, 'offer', input, async (binding) => {
            const existing = this.reserve(input, binding);
            if (existing) {
                await this.recover(existing, binding);
                if (existing.state === 'committed')
                    return clone(input.asset);
                fail('conflict');
            }
            const snapshot = await this.io(binding, async () => {
                const before = await this.io(binding, () => sourceHandle.stat({ bigint: true }));
                if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(input.asset.byte_length))
                    fail('permission_denied');
                const bytes = Buffer.alloc(input.asset.byte_length);
                let offset = 0;
                while (offset < bytes.length) {
                    const got = await this.io(binding, () => sourceHandle.read(bytes, offset, Math.min(MATERIAL_LIMITS.chunk_bytes, bytes.length - offset), offset));
                    if (!got.bytesRead)
                        fail('hash_mismatch');
                    offset += got.bytesRead;
                }
                const after = await this.io(binding, () => sourceHandle.stat({ bigint: true }));
                if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n)
                    fail('permission_denied');
                if (digest(bytes) !== input.asset.sha256)
                    fail('hash_mismatch');
                return bytes;
            });
            const now = this.clock();
            const r: RecordData = { custody: clone(binding.descriptor), storage_role: binding.storageRole, offer: clone(input), principal: binding.context.principal_id, pairing: binding.context.pairing_id, grant_revision: binding.lease.grant_revision, authorization_epoch: binding.lease.authorization_epoch, scope: clone(binding.scope), transfer_id: randomUUID(), state: 'unknown', expires_at: Math.min(input.expires_at, input.asset.expires_at, binding.lease.expires_at, binding.descriptor.expires_at, now + this.limits.asset_ttl_ms), chunks: {}, receipt: null, file: randomUUID(), inode: '', device: '' };
            if (r.expires_at <= now)
                fail('expired');
            await this.durable(r, binding);
            await this.fault('reserved', binding);
            await this.io(binding, async () => {
                const h = await this.openHandle(this.path(r), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600, binding);
                try {
                    await this.io(binding, () => {this.final(binding);return h.writeFile(snapshot);});
                    await this.io(binding, () => h.sync());
                    const stat = await this.io(binding, () => h.stat({ bigint: true }));
                    r.inode = stat.ino.toString();
                    r.device = stat.dev.toString();
                }
                finally {
                    await this.cleanup(h, binding);
                }
                await this.syncDir(join(this.root, 'bytes'), binding);
            });
            for (let offset = 0; offset < snapshot.length; offset += MATERIAL_LIMITS.chunk_bytes)
                r.chunks[offset / MATERIAL_LIMITS.chunk_bytes] = digest(snapshot.subarray(offset, offset + MATERIAL_LIMITS.chunk_bytes));
            r.snapshot_prepare = { inode: r.inode, device: r.device, sha256: input.asset.sha256, length: input.asset.byte_length };
            await this.durable(r, binding);
            await this.fault('prepare_durable', binding);
            await this.io(binding, async () => { await this.assertRename(r, binding); await this.io(binding, () => {this.final(binding);return rename(this.path(r), this.path(r, true));}); await this.syncDir(join(this.root, 'bytes'), binding); });
            await this.fault('renamed', binding);
            r.state = 'committed';
            delete r.snapshot_prepare;
            await this.durable(r, binding);
            await this.fault('commit_durable', binding);
            return clone(input.asset);
        }, 'source_snapshot', 'snapshot_register');
    }
    getSnapshot(input: {
        version: 1;
        request_id: string;
        asset_id: string;
        asset_version: number;
    }, binding: MaterialStoreBinding): Promise<MaterialSnapshotHandle> {
        const identity = parseAssetEnvelope('commit', { ...input, transfer_id: 'snapshot-lookup' });
        return this.run(binding, 'offer', identity, async (binding) => {
            const row = this.db!.prepare('SELECT data FROM transfers_v2 WHERE identity=?').get(this.identity(binding.descriptor, 'source_snapshot')) as {
                data: string;
            } | undefined;
            if (!row)
                fail('not_found');
            const record: RecordData = JSON.parse(row!.data);
            if (record.storage_role !== 'source_snapshot' || JSON.stringify(record.custody) !== JSON.stringify(binding.descriptor))
                fail('permission_denied');
            await this.recover(record, binding);
            if (this.clock() >= record.expires_at || record.state === 'expired')
                fail('expired');
            if (record.state !== 'committed')
                fail('result_unknown');
            return { kind: 'source_snapshot', snapshot_id: record.transfer_id, request_id: record.offer.request_id, asset_id: record.offer.asset.asset_id, asset_version: record.offer.asset.version };
        }, 'source_snapshot', 'snapshot_read');
    }
    readSnapshotChunk(handle: MaterialSnapshotHandle, index: number, binding: MaterialStoreBinding): Promise<Uint8Array> {
        const issued = this.snapshots.get(handle);
        if (!issued || handle.kind !== 'source_snapshot' || issued.snapshot_id !== handle.snapshot_id)
            fail('permission_denied');
        const input = parseAssetEnvelope('read_chunk', { version: 1, transfer_id: handle.snapshot_id, request_id: handle.request_id, asset_id: handle.asset_id, asset_version: handle.asset_version, chunk_index: index });
        return this.run(binding, 'offer', input, async (binding) => {
            if (issued!.custody_id !== binding.descriptor.custody_id || issued!.local_store_id !== binding.descriptor.local_store_id)
                fail('permission_denied');
            const record = this.load(input, binding);
            if (record.storage_role !== 'source_snapshot' || record.state !== 'committed' || record.receipt)
                fail('conflict');
            const offset = index * MATERIAL_LIMITS.chunk_bytes, len = Math.min(MATERIAL_LIMITS.chunk_bytes, record.offer.asset.byte_length - offset);
            if (len <= 0)
                fail('invalid');
            const bytes = await this.io(binding, async () => {
                const h = await this.file(record, binding, true);
                try {
                    const out = Buffer.alloc(len);
                    let count = 0;
                    while (count < len) {
                        const got = await this.io(binding, () => h.read(out, count, len - count, offset + count));
                        if (!got.bytesRead)
                            fail('hash_mismatch');
                        count += got.bytesRead;
                    }
                    if (digest(out) !== record.chunks[index])
                        fail('hash_mismatch');
                    return out;
                }
                finally {
                    await this.cleanup(h, binding);
                }
            });
            return new Uint8Array(bytes);
        }, 'source_snapshot', 'snapshot_read');
    }
    collectSnapshotExpired(input: {
        version: 1;
        request_id: string;
        asset_id: string;
        asset_version: number;
    }, binding: MaterialStoreBinding): Promise<void> {
        const lookup = parseAssetEnvelope('commit', { ...input, transfer_id: 'snapshot-gc' });
        return this.run(binding, 'offer', lookup, async (binding) => {
            const row = this.db!.prepare('SELECT data FROM transfers_v2 WHERE identity=?').get(this.identity(binding.descriptor, 'source_snapshot')) as {
                data: string;
            } | undefined;
            if (!row)
                fail('not_found');
            const record: RecordData = JSON.parse(row!.data);
            if (record.storage_role !== 'source_snapshot' || JSON.stringify(record.custody) !== JSON.stringify(binding.descriptor))
                fail('permission_denied');
            if (this.clock() < record.expires_at)
                return;
            if (record.state === 'unknown' && !record.inode)
                return;
            for (const committed of [false, true]) {
                try {
                    const h = await this.file(record, binding, committed);
                    await this.cleanup(h, binding);
                    await this.io(binding, () => unlink(this.path(record, committed)));
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
            }
            await this.syncDir(join(this.root, 'bytes'), binding);
            record.state = 'expired';
            await this.durable(record, binding);
        }, 'source_snapshot', 'snapshot_read');
    }
    /** GC is restricted to this exact authenticated transfer; tombstones never disappear. */
    collectExpired(input: AssetInputs['commit'], binding: MaterialStoreBinding): Promise<TransferFact> {
        input = parseAssetEnvelope('commit', input);
        return this.run(binding, binding.scope.action, input, async (binding) => {
            // load with an expiry-neutral clock is intentionally avoided: repeat exact binding checks.
            const row = this.db!.prepare('SELECT data FROM transfers_v2 WHERE id=?').get(input.transfer_id) as {
                data: string;
            } | undefined;
            if (!row)
                fail('not_found');
            const r: RecordData = JSON.parse(row!.data);
            if (JSON.stringify(r.custody) !== JSON.stringify(binding.descriptor) || r.storage_role !== binding.storageRole || r.offer.request_id !== input.request_id || r.offer.asset.asset_id !== input.asset_id || r.offer.asset.version !== input.asset_version || !sameMaterialEndpoint(r.offer.source, binding.scope.transfer.source) || !sameMaterialEndpoint(r.offer.destination, binding.scope.transfer.destination) || !sameMaterialEndpoint(r.scope.source, binding.scope.source) || !sameMaterialEndpoint(r.scope.return_to, binding.scope.return_to) || !sameMaterialEndpoint(r.scope.target, binding.scope.target))
                fail('permission_denied');
            if (this.clock() < r.expires_at)
                return this.fact(r);
            if (r.state === 'unknown' && !r.inode)
                return this.fact(r);
            await this.io(binding, async () => {
                for (const committed of [false, true]) {
                    try {
                        const h = await this.file(r, binding, committed);
                        await this.cleanup(h, binding);
                        await this.io(binding, () => unlink(this.path(r, committed)));
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                            throw error;
                    }
                }
                await this.syncDir(join(this.root, 'bytes'), binding);
            });
            r.state = 'expired';
            await this.durable(r, binding);
            return this.fact(r);
        });
    }
    /** Non-wire maintenance: current private physical-store proof, bounded cleanup, count only. */
    collectExpiredMaintenance(input: {
        limit?: number;
    } = {}): Promise<{
        collected: number;
    }> {
        const request = freeze(clone(input)), limit = request.limit ?? 32;
        if (Object.keys(request).some(key => key !== 'limit') || !Number.isSafeInteger(limit) || limit < 1 || limit > 32)
            return Promise.reject(new MaterialProtocolError('invalid'));
        if (this.closing)
            return Promise.reject(new MaterialProtocolError('offline'));
        const task = this.tail.catch(() => { }).then(async () => {
            let binding: MaintenanceBinding | undefined, transaction = false;
            try {
                const maintenanceLease = await this.options.custody.acquireMaintenance(this.options.localStoreId);
                this.options.custody.currentMaintenance(maintenanceLease);
                const descriptor = freeze(clone(maintenanceLease.descriptor));
                if (!descriptor || typeof descriptor !== 'object' || Object.keys(descriptor).some(key => !['version', 'authority_id', 'local_store_id', 'expires_at'].includes(key)) || ['version', 'authority_id', 'local_store_id', 'expires_at'].some(key => !Object.hasOwn(descriptor, key)) || descriptor.version !== 1 || descriptor.local_store_id !== this.options.localStoreId || typeof descriptor.authority_id !== 'string' || !descriptor.authority_id || Buffer.byteLength(descriptor.authority_id) > MATERIAL_LIMITS.id_bytes || !Number.isSafeInteger(descriptor.expires_at) || descriptor.expires_at <= this.clock())
                    fail('permission_denied');
                binding = { maintenanceLease, maintenanceDescriptor: descriptor };
                this.current(binding);
                try {
                    await (this.init ??= this.initialize(binding));
                }
                catch (error) {
                    this.init = undefined;
                    this.db?.close();
                    this.db = undefined;
                    throw error;
                }
                this.current(binding);
                await this.checkDirectories(binding);
                const deadline = Date.now() + (this.options.busyMs ?? 250);
                for (;;) {
                    try {
                        this.current(binding);
                        this.db!.exec('BEGIN IMMEDIATE');
                        transaction = true;
                        break;
                    }
                    catch (error) {
                        if (!String(error).includes('locked') && !String(error).includes('busy'))
                            throw error;
                        if (Date.now() >= deadline)
                            fail('offline');
                        await this.io(binding, () => new Promise<void>(r => setTimeout(r, 5)));
                    }
                }
                this.current(binding);
                const rows = this.db!.prepare("SELECT data FROM transfers_v2 WHERE json_extract(data,'$.custody.authority_id')=? AND json_extract(data,'$.custody.local_store_id')=? AND json_extract(data,'$.expires_at')<=? AND json_extract(data,'$.state')<>'expired' AND json_extract(data,'$.inode')<>'' ORDER BY id LIMIT ?").all(descriptor.authority_id, descriptor.local_store_id, this.clock(), limit) as {
                    data: string;
                }[];
                let collected = 0;
                const cleanupDeadline = performance.now() + 100;
                for (const row of rows) {
                    if (performance.now() >= cleanupDeadline)
                        break;
                    this.current(binding);
                    const record: RecordData = JSON.parse(row.data);
                    if (record.custody.authority_id !== descriptor.authority_id || record.custody.local_store_id !== descriptor.local_store_id || this.clock() < record.expires_at || !['source_snapshot', 'destination_transfer'].includes(record.storage_role) || !record.inode || !record.device)
                        continue;
                    for (const committed of [false, true]) {
                        try {
                            const h = await this.file(record, binding, committed);
                            await this.cleanup(h, binding);
                            await this.io(binding, () => unlink(this.path(record, committed)));
                        }
                        catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                                throw error;
                        }
                    }
                    await this.syncDir(join(this.root, 'bytes'), binding);
                    this.current(binding);
                    record.state = 'expired';
                    this.save(record);
                    collected++;
                }
                await this.checkDirectories(binding);
                this.final(binding);
                this.db!.exec('COMMIT');
                transaction = false;
                this.current(binding);
                return { collected };
            }
            catch (error) {
                if (transaction) {
                    try {
                        this.db!.exec('ROLLBACK');
                    }
                    catch { }
                }
                if (binding)
                    this.current(binding);
                throw error;
            }
        });
        this.tail = task;
        this.active.add(task);
        void task.finally(() => this.active.delete(task)).catch(() => { });
        return task;
    }
    async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.active]); this.db?.close(); this.db = undefined; }
}

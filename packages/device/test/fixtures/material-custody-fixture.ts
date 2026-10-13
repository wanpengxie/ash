import { createHash } from 'node:crypto';
import { MaterialProtocolError, type AssetInputs, type MaterialTrustedContext, type MaterialAuthorizationScope, type MaterialEndpointRef } from '../../src/collaboration/material-types';
import { sameMaterialEndpoint } from '../../src/collaboration/material-protocol';
import type { MaterialCustodyAuthority, MaterialCustodyLease } from '../../src/collaboration/material-custody';
/** Test-only protected slot registry: registration is explicit and separate from store offer. */
export class FixtureCustodyRegistry {
    private pairingMap = new Map([['phone', 'phone-pair'], ['mac', 'work-pair']]);
    pairingFor(node: string) { return this.pairingMap.get(node)!; }
    replacePairing(node: string, pairing: string) { this.pairingMap.set(node, pairing); this.maintenanceGeneration++; }
    private slots = new Map<string, {
        offer: AssetInputs['offer'];
        owner: string;
        id: string;
    }>();
    private maintenanceGeneration = 1;
    private maintenanceEnabled = true;
    advanceGeneration() { this.maintenanceGeneration++; }
    revokeMaintenance() { this.maintenanceEnabled = false; this.maintenanceGeneration++; }
    restoreMaintenance() { this.maintenanceEnabled = true; }
    constructor(private readonly check: (context: MaterialTrustedContext) => void, private readonly clock: () => number = Date.now) { }
    register(offer: AssetInputs['offer'], owner = 'phone-principal') {
        const key = JSON.stringify([owner, offer.request_id, offer.asset.asset_id, offer.asset.version]);
        const previous = this.slots.get(key);
        if (previous) {
            if (JSON.stringify(previous.offer) !== JSON.stringify(offer))
                throw new MaterialProtocolError('conflict');
            return;
        }
        this.slots.set(key, { offer: structuredClone(offer), owner, id: createHash('sha256').update(key).digest('hex') });
    }
    authority(localStoreId: string): MaterialCustodyAuthority {
        const leases = new WeakMap<object, {
            context: MaterialTrustedContext;
            expires: number;
        }>();
        const maintenanceLeases = new WeakMap<object, {
            generation: number;
            store: string;
        }>();
        const endpointStore = (endpoint: MaterialEndpointRef) => `${endpoint.kind === 'node' ? endpoint.node_id : endpoint.work.node_id}-store`;
        return {
            acquireMaintenance: async (store) => { if (!this.maintenanceEnabled || store !== localStoreId || !['phone-store', 'mac-store'].includes(store))
                throw new MaterialProtocolError('permission_denied'); const lease = { descriptor: Object.freeze({ version: 1 as const, authority_id: 'fixture-authority', local_store_id: localStoreId, expires_at: this.clock() + 3600000 }) }; maintenanceLeases.set(lease, { generation: this.maintenanceGeneration, store }); return lease; },
            currentMaintenance: lease => { const issued = maintenanceLeases.get(lease); if (!issued || !this.maintenanceEnabled || issued.generation !== this.maintenanceGeneration || issued.store !== localStoreId || this.clock() >= lease.descriptor.expires_at)
                throw new MaterialProtocolError('permission_denied'); return undefined; },
            acquire: async (context, scope, role, purpose) => {
                this.check(context);
                if (scope.kind !== 'request' || !scope.transfer)
                    throw new MaterialProtocolError('permission_denied');
                const slots = [...this.slots.values()].filter(s => s.offer.request_id === scope.request_id && s.offer.asset.asset_id === scope.transfer!.asset_id && s.offer.asset.version === scope.transfer!.asset_version);
                if (slots.length !== 1)
                    throw new MaterialProtocolError('permission_denied');
                const slot = slots[0], offer = slot.offer;
                const canonicalSource = { kind: 'node' as const, node_id: 'phone', endpoint_id: 'materials' }, canonicalTarget = { kind: 'work' as const, work: { node_id: 'mac', endpoint_id: 'codex', kind: 'conversation' as const, native_id: 'real-fixture-conversation' } };
                if (!sameMaterialEndpoint(scope.source, canonicalSource) || !sameMaterialEndpoint(scope.return_to, canonicalSource) || !sameMaterialEndpoint(scope.target, canonicalTarget) || !sameMaterialEndpoint(scope.transfer.source, offer.source) || !sameMaterialEndpoint(scope.transfer.destination, offer.destination))
                    throw new MaterialProtocolError('permission_denied');
                const actor = role === 'source_snapshot' || ['offer', 'put_chunk', 'commit'].includes(scope.action) ? offer.source : offer.destination;
                const node = actor.kind === 'node' ? actor.node_id : actor.work.node_id;
                const principal = node === 'phone' ? 'phone-principal' : 'work-principal', pairing = this.pairingFor(node);
                if (context.principal_id !== principal || context.pairing_id !== pairing || !sameMaterialEndpoint(context.source_binding, actor) || localStoreId !== endpointStore(role === 'source_snapshot' ? offer.source : offer.destination) || (role === 'source_snapshot' ? (purpose === 'wire' || scope.action !== 'offer') : purpose !== 'wire'))
                    throw new MaterialProtocolError('permission_denied');
                const lease: MaterialCustodyLease = Object.freeze({ descriptor: Object.freeze({ version: 1, custody_id: slot.id, authority_id: 'fixture-authority', owner_principal_id: slot.owner, request_id: offer.request_id, asset_id: offer.asset.asset_id, asset_version: offer.asset.version, sha256: offer.asset.sha256, byte_length: offer.asset.byte_length, source: structuredClone(offer.source), destination: structuredClone(offer.destination), local_store_id: localStoreId, expires_at: Math.min(offer.expires_at, offer.asset.expires_at) }) });
                leases.set(lease, { context: structuredClone(context), expires: lease.descriptor.expires_at });
                return lease;
            },
            current: lease => {
                const privateRecord = leases.get(lease);
                if (!privateRecord)
                    throw new MaterialProtocolError('permission_denied');
                this.check(privateRecord.context);
                return undefined;
            }
        };
    }
}

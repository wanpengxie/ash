import type { MaterialEndpointRef, MaterialTrustedContext, MaterialAuthorizationScope } from './material-types';
/** Protected registry metadata. Never accepted from a model or substituted for actor identity. */
export interface MaterialCustodyDescriptor {
    readonly version: 1;
    readonly custody_id: string;
    readonly authority_id: string;
    readonly owner_principal_id: string;
    readonly request_id: string;
    readonly asset_id: string;
    readonly asset_version: number;
    readonly sha256: string;
    readonly byte_length: number;
    readonly source: MaterialEndpointRef;
    readonly destination: MaterialEndpointRef;
    readonly local_store_id: string;
    readonly expires_at: number;
}
export interface MaterialCustodyLease {
    readonly descriptor: Readonly<MaterialCustodyDescriptor>;
}
/** Dedicated physical-store maintenance proof. It conveys no actor or historical read permission. */
export interface MaterialCustodyMaintenanceDescriptor {
    readonly version: 1;
    readonly authority_id: string;
    readonly local_store_id: string;
    readonly expires_at: number;
}
export interface MaterialCustodyMaintenanceLease {
    readonly descriptor: Readonly<MaterialCustodyMaintenanceDescriptor>;
}
export type MaterialStorageRole = 'destination_transfer' | 'source_snapshot';
export type MaterialCustodyPurpose = 'wire' | 'snapshot_register' | 'snapshot_read';
/** Implementations must validate identity using private issued-lease records, and current global authority epoch. */
export interface MaterialCustodyAuthority {
    acquire(context: Readonly<MaterialTrustedContext>, scope: Readonly<MaterialAuthorizationScope>, storageRole: MaterialStorageRole, purpose: MaterialCustodyPurpose): Promise<MaterialCustodyLease>;
    current(lease: MaterialCustodyLease): undefined;
    acquireMaintenance(localStoreId: string): Promise<MaterialCustodyMaintenanceLease>;
    currentMaintenance(lease: MaterialCustodyMaintenanceLease): undefined;
}
/** Internal locator only; access always reacquires the current source actor's custody proof. */
export interface MaterialSnapshotHandle {
    readonly kind: 'source_snapshot';
    readonly snapshot_id: string;
    readonly request_id: string;
    readonly asset_id: string;
    readonly asset_version: number;
}

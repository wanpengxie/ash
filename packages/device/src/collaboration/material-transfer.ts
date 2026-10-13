import { MaterialProtocolError, type AssetOperation, type AssetInputs, type MaterialTrustedContext, type MaterialAuthorization, type MaterialAuthorizationScope, type MaterialAssetService, type TransferFact } from './material-types';
import { parseAssetEnvelope, assertMaterialEnvelopeSize } from './material-protocol';
import { MaterialAssetStore, type MaterialStoreBinding } from './material-store';
export interface MaterialTransferServiceOptions {
    store: MaterialAssetStore;
    authorization: MaterialAuthorization;
    /** Must track the shared monotonic authority epoch, including custody/peer/endpoint changes; retain through final external output. */
    currentContext(context: MaterialTrustedContext): undefined;
    /** Resolve from protected request + current exact directional asset grant, never body authority. */
    resolveScope<K extends AssetOperation>(operation: K, input: AssetInputs[K], context: MaterialTrustedContext): Promise<Extract<MaterialAuthorizationScope, {
        kind: 'request';
        action: AssetOperation;
    }>>;
}
export class MaterialTransferService implements MaterialAssetService {
    constructor(private readonly options: MaterialTransferServiceOptions) { }
    async invoke<K extends AssetOperation>(operation: K, input: AssetInputs[K], context: MaterialTrustedContext): Promise<K extends 'read_chunk' ? AssetInputs['put_chunk'] : TransferFact> {
        context = structuredClone(context);
        this.options.currentContext(context);
        let parsed: AssetInputs[K];
        try {
            parsed = parseAssetEnvelope(operation, input);
        }
        catch (error) {
            this.options.currentContext(context);
            throw error;
        }
        const freeze = <T>(value: T): T => {
            if (value && typeof value === 'object') {
                for (const v of Object.values(value))
                    freeze(v);
                Object.freeze(value);
            }
            return value;
        };
        parsed = freeze(parsed);
        let scope: Extract<MaterialAuthorizationScope, {
            kind: 'request';
            action: AssetOperation;
        }>;
        try {
            scope = freeze(structuredClone(await this.options.resolveScope(operation, parsed, freeze(context))));
        }
        catch (error) {
            this.options.currentContext(context);
            throw error;
        }
        this.options.currentContext(context);
        if (scope.kind !== 'request' || scope.action !== operation || !scope.transfer)
            throw new MaterialProtocolError('permission_denied');
        let lease: MaterialTrustedContext;
        try {
            lease = freeze(structuredClone(await this.options.authorization.before(context, scope)));
        }
        catch (error) {
            this.options.currentContext(context);
            throw error;
        }
        this.options.currentContext(context);
        const binding: MaterialStoreBinding = { context, scope, lease };
        try {
            await this.options.authorization.after(lease, scope);
            this.options.authorization.current(lease, scope);
            const store = this.options.store;
            let result: AssetInputs['put_chunk'] | TransferFact;
            switch (operation) {
                case 'offer':
                    result = await store.offer(parsed as AssetInputs['offer'], binding);
                    break;
                case 'put_chunk':
                    result = await store.putChunk(parsed as AssetInputs['put_chunk'], binding);
                    break;
                case 'commit':
                    result = await store.commit(parsed as AssetInputs['commit'], binding);
                    break;
                case 'read_chunk':
                    result = await store.readChunk(parsed as AssetInputs['read_chunk'], binding);
                    break;
                case 'ack':
                    result = await store.ack(parsed as AssetInputs['ack'], binding);
                    break;
                default: throw new MaterialProtocolError('unsupported');
            }
            assertMaterialEnvelopeSize(result);
            await this.options.authorization.after(lease, scope);
            this.options.authorization.current(lease, scope);
            this.options.currentContext(context);
            return result as K extends 'read_chunk' ? AssetInputs['put_chunk'] : TransferFact;
        }
        catch (error) {
            await this.options.authorization.after(lease, scope);
            this.options.authorization.current(lease, scope);
            this.options.currentContext(context);
            throw error;
        }
    }
}

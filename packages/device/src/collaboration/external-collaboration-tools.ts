import { MaterialProtocolError, type MaterialOperation, type AssetOperation, type MaterialInputs, type AssetInputs } from "./material-types";
import { MATERIAL_OPERATIONS, ASSET_OPERATIONS, MaterialClient, type MaterialCallBinding, type RelayOperation } from "./material-client";
/** Owned by the connector; acquire authenticates private credential and actual host invocation session. Never accept model native_id as proof. */
export interface ExternalMaterialBindingProvider {
  /** Must release connector acquisition resources when aborted; late completion never authorizes a call. */
  acquire(signal: AbortSignal): Promise<MaterialCallBinding>;
  current(binding: MaterialCallBinding): undefined;
  available(): readonly RelayOperation[];
}
/** Current repository has thread/read existence evidence, but no authenticated Codex tool-invocation-to-thread source. A5 must install one. */
export class UnsupportedCodexMaterialBindingProvider implements ExternalMaterialBindingProvider {
  async acquire(): Promise<MaterialCallBinding> { throw new MaterialProtocolError("unsupported"); }
  current(_binding: MaterialCallBinding): undefined { throw new MaterialProtocolError("unsupported"); }
  available(): readonly RelayOperation[] { return []; }
}
export interface ExternalCollaborationToolsOptions { maxAuthenticating?: number; budgetMs?: number; }
export class ExternalCollaborationTools {
  private epoch = 0;
  private closed = false;
  private providerActive = new Set<object>();
  private acquisitions = new Map<object, { abort: AbortController; reject(error: Error): void }>();
  private readonly maxAuthenticating: number;
  private readonly budget: number;
  constructor(private readonly client: MaterialClient, private readonly bindings: ExternalMaterialBindingProvider, options: ExternalCollaborationToolsOptions = {}) {
    this.maxAuthenticating = options.maxAuthenticating ?? 32; this.budget = options.budgetMs ?? 30_000;
    if (!Number.isInteger(this.maxAuthenticating) || this.maxAuthenticating < 1 || this.maxAuthenticating > 32 || !Number.isInteger(this.budget) || this.budget < 1 || this.budget > 30_000) throw new MaterialProtocolError("invalid");
  }
  available(): readonly RelayOperation[] { if (this.closed) return []; const available = this.bindings.available(); return [...MATERIAL_OPERATIONS, ...ASSET_OPERATIONS].filter(x => available.includes(x)); }
  async invoke<K extends MaterialOperation>(operation: K, input: MaterialInputs[K]) {
    const binding = await this.acquire(operation);
    try { const result = await this.client.invoke(operation, input, binding); binding.current(); return result; }
    catch (e) { binding.current(); throw e; }
  }
  async invokeAsset<K extends AssetOperation>(operation: K, input: AssetInputs[K]) {
    const binding = await this.acquire(operation);
    try { const result = await this.client.invokeAsset(operation, input, binding); binding.current(); return result; }
    catch (e) { binding.current(); throw e; }
  }
  private async acquire(operation: RelayOperation): Promise<MaterialCallBinding> {
    if (this.closed) throw new MaterialProtocolError("offline");
    if (!this.available().includes(operation)) throw new MaterialProtocolError("unsupported");
    // Reserve before calling the provider or allocating its promise/timer; there is no queue.
    if (this.providerActive.size >= this.maxAuthenticating) throw new MaterialProtocolError("too_large");
    const token = {}, epoch = this.epoch, abort = new AbortController(), deadline = Date.now() + this.budget;
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_, fail) => { reject = fail; });
    this.providerActive.add(token);
    this.acquisitions.set(token, { abort, reject });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fence = (): undefined => { if (this.closed || this.epoch !== epoch || abort.signal.aborted) throw new MaterialProtocolError("offline"); if (Date.now() >= deadline) throw new MaterialProtocolError("timeout"); return undefined; };
    let binding: MaterialCallBinding;
    try {
      timer = setTimeout(() => { reject(new MaterialProtocolError("timeout")); abort.abort(); }, this.budget);
      let underlying: Promise<MaterialCallBinding>;
      try { underlying = Promise.resolve(this.bindings.acquire(abort.signal)); }
      catch (error) { this.providerActive.delete(token); throw error; }
      // Only original provider settlement releases capacity. Timeout/abort cannot
      // prove that a provider ignoring cancellation has stopped its native work.
      const provider = underlying.then(
        value => { this.providerActive.delete(token); return value; },
        error => { this.providerActive.delete(token); throw error; },
      );
      binding = await Promise.race([provider, cancelled]);
      fence(); this.bindings.current(binding); binding.current(); fence();
    } finally { if (timer) clearTimeout(timer); this.acquisitions.delete(token); }
    const current = (): undefined => { fence(); this.bindings.current(binding); binding.current(); fence(); return undefined; };
    current(); return Object.freeze({ binding_id: binding.binding_id, deadline, current });
  }
  invalidate(): void {
    this.epoch++;
    for (const acquisition of this.acquisitions.values()) { acquisition.reject(new MaterialProtocolError("offline")); acquisition.abort.abort(); }
    this.acquisitions.clear(); this.client.invalidate();
  }
  close(): void { this.closed = true; this.invalidate(); this.client.close(); }
  get authenticating(): number { return this.providerActive.size; }
}

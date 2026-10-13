import type {Page} from '@playwright/test';
/** Fixture-only native callback ownership. Epochs are lifecycle metadata, not credentials. */
export class MaterialUiNativeEmitter {
 private epoch?:string;private closed=false;private readonly pending=new Set<Promise<void>>();
 constructor(private readonly page:Pick<Page,'evaluate'|'isClosed'>){}
 activate(epoch:string){if(this.closed||typeof epoch!=='string'||!epoch||epoch.length>128)throw Error('Fixture emitter epoch');this.epoch=epoch;}
 retire(){this.epoch=undefined;}
 current(epoch:string){return !this.closed&&!this.page.isClosed()&&this.epoch===epoch;}
 emit(message:unknown,epoch:string):Promise<void>{const raw=(async()=>{if(this.closed||this.page.isClosed()||this.epoch!==epoch)return;try{await this.page.evaluate(({message,epoch})=>{if((globalThis as any).__materialFixturePageEpoch!==epoch)return;const handler=(globalThis as any).AshNative?.onmessage;if(typeof handler!=='function')throw Error('Current fixture native listener unavailable');handler({data:JSON.stringify(message)});},{message,epoch});}catch(error){if(this.closed||this.page.isClosed()||this.epoch!==epoch)return;throw error;}})();this.pending.add(raw);raw.finally(()=>this.pending.delete(raw)).catch(()=>{});return raw;}
 async drain(){while(this.pending.size)await Promise.allSettled([...this.pending]);}
 async close(){this.closed=true;this.retire();await this.drain();}
 get busy(){return this.pending.size;}
}

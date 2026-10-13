/** Coworker runs through the hub's authenticated human and device channels. */
import { createHash } from 'node:crypto';
import { WordError, isErrorCode, type ErrorCode, type HandleContext, type Message } from '../../../../sdk/src/message';
import type { Member, WordContract } from '../../../../sdk/src/word';
import type { Router, Registry } from '../../kernel/types';
import { boundedRead, CoreReadError, normalizeReadTarget, parseReadInput, validateReadPage, READ_CAPABILITIES, type ReadInput } from './read-service';
import { FixedCreateTransport, executeCreateRoute, normalizeCreateTarget } from './create-service';
import { FixedControlTransport, executeControlRoute, normalizeControlTarget } from './control-service';
import { ResultFileService, parseResultInput, resultObject } from './result-file-service';

export interface CollaborationServiceOptions {
  router: Pick<Router, 'send'>;
  registry: Registry;
  hands: { get(id:string): { id:string; name:string; public_key:string; paired_at:number; lend:boolean; web_ui:boolean; revoked_at:number|null; manifest_rev:number|null; manifest_hash:string|null } | null; online(id:string):boolean };
  /** The exact authenticated human connection is still open. */
  currentClient(client: string): boolean;
  now?: () => number;
  openStream?(client:string,bytes:Uint8Array,mime:string):string;
  materials?: {dispatch(word:string,input:unknown,ctx:HandleContext,scope:string,current:()=>void):Promise<unknown>};
}
const WORDS = ['collaboration.endpoints', 'collaboration.control.endpoints', 'collaboration.create.endpoints', 'collaboration.read',
  ...['state','apply','query','reconcile'].map(x => `collaboration.control.${x}`),
  ...['projects','apply','query','reconcile'].map(x => `collaboration.create.${x}`),
  ...['prepare','snapshot','check'].map(x => `collaboration.result.${x}`),
  ...['scope','import','import.begin','import.chunk','import.commit','draft.save','draft.load','draft.delete','requests.list','requests.read','input.submit','input.send','input.query','input.retry'].map(x=>`collaboration.material.${x}`)];
const canonicalCode = (code: string): ErrorCode => ({ invalid:'bad_request', permission_denied:'forbidden', unsupported:'unavailable', expired:'conflict', busy:'conflict', stale_precondition:'conflict', hash_mismatch:'conflict', storage_failure:'unavailable' } as Record<string,ErrorCode>)[code] ?? (isErrorCode(code) ? code : 'failed');
export function collaborationError(error: unknown): WordError {
  if (error instanceof WordError) return error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'offline';
  return new WordError(canonicalCode(code), `Coworker ${code}`, { detail: { code } });
}

export function createCollaborationService(d: CollaborationServiceOptions): Member {
  const now = d.now ?? Date.now;
  // Handles are scoped to the human client and its stable pairing scope; they never become local paths.
  const resultServices = new Map<string, ResultFileService>();
  function admitted(ctx: HandleContext) {
    const c = ctx.caller;
    if (c.member !== 'person:owner' || c.via !== 'human' || !c.client || !c.origin?.hand) throw new CoreReadError('permission_denied');
    const handId = c.origin.hand.slice(7), hand = d.hands.get(handId);
    if (!hand || hand.revoked_at || !hand.web_ui || !d.currentClient(c.client)) throw new CoreReadError('permission_denied');
    const pairing = JSON.stringify([hand.id, hand.public_key, hand.paired_at]);
    const current = () => {
      const live = d.hands.get(handId);
      if (ctx.signal.aborted) throw new CoreReadError('cancelled');
      if (!live || live.revoked_at || !live.web_ui || JSON.stringify([live.id,live.public_key,live.paired_at]) !== pairing || !d.currentClient(c.client!)) throw new CoreReadError('permission_denied');
    };
    current();
    return { current, scope: createHash('sha256').update(pairing).digest('hex'), client: c.client };
  }
  function deviceSession(ctx: HandleContext, currentOwner: () => void, signal: AbortSignal) {
    const captured = new Map<string, { member: Member; identity: string }>();
    const identity = (id: string) => { const h = d.hands.get(id); return h && !h.revoked_at && h.lend && d.hands.online(id) ? JSON.stringify([h.public_key,h.paired_at,h.manifest_rev,h.manifest_hash]) : null; };
    const current = () => { currentOwner(); if (signal.aborted) throw new CoreReadError('cancelled'); for (const [id,c] of captured) if (identity(id) !== c.identity || d.registry.get(`device:${id}`) !== c.member) throw new CoreReadError('permission_denied'); };
    const call = async (id: string, word: string, args: Record<string,unknown>) => {
      current();
      if (!captured.has(id)) { const member = d.registry.get(`device:${id}`), stamp = identity(id); if (!member || !stamp) throw new CoreReadError('offline'); captured.set(id,{member,identity:stamp}); }
      current(); const reply = await d.router.send({ to:`device:${id}`,kind:'request',word,body:args },ctx.caller,{signal}); current();
      if (!reply.ok) { const detail = reply.error.detail as {code?:unknown}|undefined; throw new CoreReadError(typeof detail?.code === 'string' ? detail.code : reply.error.code); }
      if ((reply.result?.content?.length ?? 0) !== 0) throw new CoreReadError('invalid');
      return reply.result?.data;
    };
    const inspect = async (id: string, _signal: AbortSignal) => {
      const description = await call(id,'collaboration.endpoint.describe',{});
      current(); const h = d.hands.get(id)!;
      const capabilities = d.registry.describe(`device:${id}`)?.words.map(c=>({name:c.word,risk:c.risk})) ?? [];
      return { id,name:h.name,online:d.hands.online(id),revoked:Boolean(h.revoked_at),permissions:h.lend?['expose_capability']:[],manifest:{...(description as object),capabilities} };
    };
    const exchange = async (id: string, request: {capability:string;args:unknown}, _signal:AbortSignal) => {
      try { const data = await call(id,request.capability,request.args as Record<string,unknown>); return {status:200,body:Buffer.from(JSON.stringify({ok:true,content:[],data}))}; }
      catch (error) { current(); const code = error instanceof CoreReadError ? error.code : 'offline'; return {status:200,body:Buffer.from(JSON.stringify({ok:false,content:[],data:{code},error:`Coworker ${code}`}))}; }
    };
    return {current,inspect,exchange,call};
  }
  async function run(msg: Message, ctx: HandleContext) {
    const a = admitted(ctx), word = msg.word, body = ctx.raw ?? msg.body;
    const bytes = Buffer.from(JSON.stringify(body ?? {}));
    const session = deviceSession(ctx,a.current,ctx.signal);
    let value: unknown;
    if (word.startsWith('collaboration.material.')) {
      if (!d.materials) throw new CoreReadError('unsupported');
      value = {result:await d.materials.dispatch(word,body,ctx,a.scope,a.current)};
    } else if (word.endsWith('.endpoints')) {
      if (bytes.toString() !== '{}') throw new CoreReadError('invalid');
      value = await boundedRead(ctx.signal,30_000,async signal => {
        const targets = [];
        const discovered = deviceSession(ctx,a.current,signal);
        for (const member of d.registry.findByWord('collaboration.endpoint.describe',{kind:'device'})) {
          const id = member.id.slice(7), h = d.hands.get(id);
          if (member.kind !== 'device' || !h?.lend || h.revoked_at || !d.hands.online(id)) continue;
          const device = await discovered.inspect(id,signal);
          const target = word === 'collaboration.control.endpoints' ? normalizeControlTarget(id,h.name,device.manifest) : word === 'collaboration.create.endpoints' ? normalizeCreateTarget(id,h.name,device.manifest) : normalizeReadTarget(id,h.name,device.manifest);
          if (target) targets.push(target);
        }
        discovered.current();
        return { [word === 'collaboration.control.endpoints' ? 'control_targets' : word === 'collaboration.create.endpoints' ? 'create_targets' : 'targets']:targets,observed_at:new Date(now()).toISOString() };
      });
    } else if (word === 'collaboration.read') {
      value = await boundedRead(ctx.signal,30_000,async signal => {
        const input = parseReadInput(bytes), id = input.device_id.slice(7), read = deviceSession(ctx,a.current,signal);
        const before = await read.inspect(id,signal), target = normalizeReadTarget(id,before.name,before.manifest);
        if (!target || target.authorization_state !== 'ready' || !target.actions.includes(input.action) || target.authorization_generation !== input.authorization_generation || target.authorization_revision !== input.authorization_revision) throw new CoreReadError('permission_denied');
        const {device_id:_device,...args} = input;
        const page = await read.call(id,READ_CAPABILITIES[input.action],args);
        const after = await read.inspect(id,signal);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new CoreReadError('permission_denied');
        read.current(); return {target:{device_id:target.device_id,node_id:target.node_id,endpoint_id:target.endpoint_id,authorization_generation:target.authorization_generation,authorization_revision:target.authorization_revision},page:validateReadPage(page,input)};
      });
    } else if (word.startsWith('collaboration.control.')) {
      value = await executeControlRoute({method:'POST',url:new URL(`/api/collaboration/control/${word.split('.').at(-1)}`,'http://coworker'),body:bytes,signal:ctx.signal},{authorize:async()=>a.current(),current:a.current},new FixedControlTransport(signal=>deviceSession(ctx,a.current,signal)));
    } else if (word.startsWith('collaboration.create.')) {
      value = await executeCreateRoute({method:'POST',url:new URL(`/api/collaboration/create/${word.split('.').at(-1)}`,'http://coworker'),body:bytes,signal:ctx.signal},{authorize:async()=>a.current(),current:a.current},new FixedCreateTransport(signal=>deviceSession(ctx,a.current,signal)));
    } else if (word.startsWith('collaboration.result.')) {
      const owner = JSON.stringify([a.scope,a.client]);
      let files = resultServices.get(owner);
      if (!files) {
        if (resultServices.size >= 128) { for (const key of resultServices.keys()) if (!d.currentClient(JSON.parse(key)[1])) resultServices.delete(key); if (resultServices.size >= 128) throw new CoreReadError('too_large'); }
        // Each operation supplies its live channel; no context is cached across reconnects.
        files = new ResultFileService({resultCall:async()=>{throw new CoreReadError('offline');}},now); resultServices.set(owner,files);
      }
      const captureResult = async (input:ReadInput, signal:AbortSignal) => {
        const read = deviceSession(ctx,a.current,signal), id = input.device_id.slice(7), before = await read.inspect(id,signal), target = normalizeReadTarget(id,before.name,before.manifest);
        if (!target || target.authorization_state !== 'ready' || target.authorization_generation !== input.authorization_generation || target.authorization_revision !== input.authorization_revision) throw new CoreReadError('permission_denied');
        const finish = async () => { const after = await read.inspect(id,signal); if (JSON.stringify(before) !== JSON.stringify(after)) throw new CoreReadError('permission_denied'); read.current(); };
        return { call:(capability:string,args:Record<string,unknown>)=>read.call(id,capability,args), finish };
      };
      const transport = {
        resultCall:async(input:ReadInput,capability:string,args:Record<string,unknown>,signal:AbortSignal) => { const lease = await captureResult(input,signal); const result = await lease.call(capability,args); await lease.finish(); return result; },
        beginResultSnapshot:async(input:ReadInput,signal:AbortSignal) => { const lease = await captureResult(input,signal); return {call:(args:Record<string,unknown>)=>lease.call('collaboration.result.read_chunk',args),finish:lease.finish}; },
      };
      files = files.fork(transport);
      const result = await boundedRead(ctx.signal,30_000,async signal => {
        if (word === 'collaboration.result.prepare') return files!.prepare(owner,parseResultInput(bytes),signal,a.current);
        const b = resultObject(body,['save_id','asset_version','sha256']);
        if (typeof b.save_id !== 'string' || b.save_id.length>256 || !Number.isSafeInteger(b.asset_version) || b.asset_version<1 || !/^[a-f0-9]{64}$/.test(b.sha256)) throw new CoreReadError('invalid');
        if (word === 'collaboration.result.snapshot') {
          const snapshot = await files!.snapshot(owner,b.save_id,b.asset_version,b.sha256,signal,a.current);
          if (!d.openStream) return snapshot;
          a.current(); const bytes = Buffer.from(snapshot.bytes_base64,'base64');
          const stream = d.openStream(a.client,bytes,snapshot.asset.media_type);
          a.current(); return {asset:snapshot.asset,stream,mime:snapshot.asset.media_type,size:bytes.length};
        }
        if (word === 'collaboration.result.check') return files!.check(owner,b.save_id,b.asset_version,b.sha256,signal,a.current);
        throw new CoreReadError('unsupported');
      });
      value = {result};
    } else throw new CoreReadError('unsupported');
    session.current(); a.current(); return {data:{ok:true,auth_scope:a.scope,...value as object}};
  }
  return {id:'service:collaboration',kind:'service',name:'Coworker',words:():WordContract[]=>WORDS.map(word=>({member:'service:collaboration',word,kind:'request',direction:'in',description:'Read or control an explicitly authorized computer coworker.',input_schema:{type:'object',additionalProperties:true,'x-ash-secret':true},result_schema:{type:'object',additionalProperties:true,'x-ash-sensitive':{mask:'hidden'}},effect:word.endsWith('.apply')||word.endsWith('input.send')||word.endsWith('input.submit')?'act':word.startsWith('collaboration.material.')&&!['scope','draft.load','requests.list','requests.read','input.query'].some(x=>word.endsWith(x))?'write':'read',risk:word.endsWith('.apply')||word.endsWith('input.send')||word.endsWith('input.submit')?'outward':'none',callers:['owner'],timeout_ms:180_000,label:{doing:'在连接电脑会话'}})),async handle(msg,ctx){try{return await run(msg,ctx);}catch(error){throw collaborationError(error);}}};
}

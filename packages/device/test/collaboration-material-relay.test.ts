/// <reference path="./fixtures/material-gateway-runtime-types.d.ts" />
import test from "node:test";
import assert from "node:assert/strict";
import { DeviceKey, GatewayClient } from "ash-gateway/client/client";
import { DeviceTunnels } from "ash-gateway/src/device-tunnels";
import { MaterialClient, MATERIAL_REQUEST_TYPE, MATERIAL_RESPONSE_TYPE, relaySize } from "../src/collaboration/material-client";
import { ExternalCollaborationTools, UnsupportedCodexMaterialBindingProvider } from "../src/collaboration/external-collaboration-tools";
import { MaterialGatewayAdapter, MaterialGatewayReplayOwner } from "../src/collaboration/material-gateway";
import { MaterialProtocolError } from "../src/collaboration/material-types";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function setup(budgetMs = 500, maxReplayEntries = 4096, observeUnfinished?:(work:Promise<unknown>)=>undefined,replayOwner?:MaterialGatewayReplayOwner) {
  const a = await DeviceKey.generate(), b = await DeviceKey.generate();
  const ga = new GatewayClient("https://fixture.invalid", a), gb = new GatewayClient("https://fixture.invalid", b);
  let generation = "1", authorized = true, sends = 0, calls = 0;
  const qa: any[] = [], qb: any[] = [];
  const make = (local: DeviceKey, peer: DeviceKey, queue: any[]) => ({
    async capture() { return { local_id: local.id, peer_id: peer.id, public_key: peer.publicKey, pairing_id: "pair", generation }; },
    current(p: any): undefined { if (p.generation !== generation || !authorized) throw new MaterialProtocolError("permission_denied"); return undefined; },
    send(e: any): undefined { assert.equal(e.from, local.id); assert.equal(e.to, peer.id); relaySize(e); queue.push(e); sends++; return undefined; }
  });
  const context = { principal_id: "external-one", pairing_id: "pair", grant_revision: "g1", authorization_epoch: "e1", source_binding: { kind: "work" as const, work: { node_id: "desktop", endpoint_id: "codex", kind: "conversation" as const, native_id: "host-verified-thread" } }, expires_at: Date.now() + 60000 };
  const binding = { binding_id: "opaque-private-session-handle", current(): undefined { if (!authorized) throw new MaterialProtocolError("permission_denied"); return undefined; } };
  let assetService: any = async () => { throw new MaterialProtocolError("unsupported"); };
  let requestService = async (_op: any, input: any) => { calls++; return { version: 1, target: input.target, capabilities: ["human_material"] }; };
  const client = new MaterialClient({ gateway: ga, transport: make(a, b, qa), budgetMs,observeUnfinished });
  const adapterOptions={ maxReplayEntries,observeUnfinished,replayOwner, gateway: gb, transport: make(b, a, qb), bindings: { async resolve(id:string, peer:import("../src/collaboration/material-client").MaterialRelayPeer) { if (id !== binding.binding_id || peer.peer_id !== a.id) throw new MaterialProtocolError("permission_denied"); return { context, current: binding.current }; } }, requests: { invoke: ((o: any, i: any) => requestService(o, i)) as any }, assets: { invoke: ((o: any, i: any, c: any) => assetService(o,i,c)) as any } };
  const adapter=new MaterialGatewayAdapter(adapterOptions);
  const input = { version: 1 as const, target: { node_id: "phone", endpoint_id: "materials" } };
  const start = () => { const promise = client.invoke("discover", input, binding); return promise; };
  const sent = async () => { for (let n = 0; !qa.length && n < 30; n++) await delay(2); assert.ok(qa.length); return qa.shift(); };
  return { a, b, ga, gb, qa, qb, client, adapter, adapterOptions, input, binding, start, sent, counts: () => ({ sends, calls }), aba: () => { generation = String(Number(generation) + 1); }, revoke: () => { authorized = false; }, assetService: (f: any) => { assetService = f; }, service: (f: typeof requestService) => { requestService = f; } };
}
test("two independent endpoints use actual gateway signatures and fixed request/response types", async () => {
  const f = await setup(); const p = f.start(), request = await f.sent(); assert.equal(request.type, MATERIAL_REQUEST_TYPE); assert.ok(await GatewayClient.verifyEnvelope(request, f.a.publicKey));
  await f.adapter.acceptFrame(request); assert.equal(f.qb[0].type, MATERIAL_RESPONSE_TYPE); assert.equal(f.qb[0].reply_to, request.message_id); assert.ok(await GatewayClient.verifyEnvelope(f.qb[0], f.b.publicKey));
  await f.client.acceptFrame(f.qb.shift()); assert.deepEqual(await p, { version: 1, target: f.input.target, capabilities: ["human_material"] }); assert.equal(f.client.inflight, 0);
  await f.adapter.acceptFrame(request); assert.equal(f.counts().calls, 1); f.client.close(); f.adapter.close();
});
test("gateway delivered control frame never resolves an application waiter", async () => { const f = await setup(40), p = f.start(); const fail = assert.rejects(p, { code: "timeout" }); await f.sent(); assert.equal(await f.client.acceptFrame({ t: "gw", op: "delivered" }), false); await fail; assert.equal(f.client.inflight, 0); f.client.close(); f.adapter.close(); });
test("malformed signature, expiry, another device and model fields cannot admit service", async () => {
  const f = await setup(80), p = f.start(), fail = assert.rejects(p, { code: "timeout" }), e = await f.sent();
  for (const bad of [{ ...e, sig: "invalid" }, { ...e, expires_at: Date.now()-1 }, { ...e, from: "another-device" }, { ...e, payload: JSON.stringify({ ...JSON.parse(e.payload), native_id: "host-verified-thread" }) }]) await f.adapter.acceptFrame(bad);
  const unknown = await f.ga.envelope(MATERIAL_REQUEST_TYPE, f.b.id, { ...JSON.parse(e.payload), binding_id: "same-computer-unbound-session" }, { ttlMs: 60 }); await f.adapter.acceptFrame(unknown);
  assert.equal(f.counts().calls, 0); await fail; f.client.close(); f.adapter.close();
});
for (const mismatch of ["reply", "call", "from", "signature"] as const) test(`response ${mismatch} mismatch cannot resolve result`, async () => {
  const f = await setup(80), p = f.start(), fail = assert.rejects(p), e = await f.sent(); await f.adapter.acceptFrame(e); const body = JSON.parse(f.qb[0].payload);
  if (mismatch === "call") body.call_id = "other-call";
  let bad = await f.gb.envelope(MATERIAL_RESPONSE_TYPE, f.a.id, body, { ttlMs: 20, replyTo: mismatch === "reply" ? "other-message" : e.message_id });
  if (mismatch === "from") bad = { ...bad, from: "another-device" }; if (mismatch === "signature") bad = { ...bad, sig: "invalid" };
  await f.client.acceptFrame(bad); await fail; assert.equal(f.client.inflight, 0); f.client.close(); f.adapter.close();
});
test("ABA during service prevents final response; invalidate removes waiters and drops late replies", async () => {
  const f = await setup(200); let release!: () => void; f.service(async (_o, i) => { await new Promise<void>(r => release = r); return { version: 1, target: i.target, capabilities: [] }; });
  const p = f.start(), fail = assert.rejects(p, { code: "offline" }), e = await f.sent(), work = f.adapter.acceptFrame(e); for (let n=0; !release && n<30; n++) await delay(2);
  f.aba(); f.client.invalidate(); release(); await work; await fail; assert.equal(f.qb.length, 0); assert.equal(f.client.inflight, 0); assert.equal(f.adapter.inflight, 0); f.client.close(); f.adapter.close();
});
test("timeout has no automatic retransmission and late response is discarded", async () => { const f = await setup(30), p = f.start(), fail = assert.rejects(p, { code: "timeout" }), e = await f.sent(); await fail; await f.adapter.acceptFrame(e); if(f.qb.length) await f.client.acceptFrame(f.qb.shift()); assert.equal(f.counts().sends, 1); assert.equal(f.client.inflight, 0); f.client.close(); f.adapter.close(); });
test("inflight cap and final UTF8 envelope accounting include escaping/signature", async () => {
  const f = await setup(100); const promises = Array.from({length:32}, () => { const p = f.start(); return assert.rejects(p); }); await assert.rejects(f.start(), {code:"too_large"}); f.client.close(); await Promise.all(promises); f.adapter.close();
  const key = await DeviceKey.generate(), gateway = new GatewayClient("https://fixture.invalid",key);
  const e = await gateway.envelope(MATERIAL_REQUEST_TYPE,"owner", { data: "\\".repeat(33000) }); assert.throws(() => relaySize(e), { code: "too_large" });
  const exact = { text: "x".repeat(65525) }; assert.equal(Buffer.byteLength(JSON.stringify(exact)),65536); relaySize(exact); assert.throws(()=>relaySize({text: exact.text+"x"}), {code:"too_large"});
});
test("unsupported Codex host binding exposes no tools and refuses model native identity", async () => { const f = await setup(); const tools = new ExternalCollaborationTools(f.client,new UnsupportedCodexMaterialBindingProvider()); assert.deepEqual(tools.available(),[]); await assert.rejects(tools.invoke("discover",f.input),{code:"unsupported"}); assert.equal(f.counts().sends,0); f.client.close(); f.adapter.close(); });
test("actual gateway DeviceTunnels rejects client-originated http.req", () => { const owner: any[] = [], device: any[] = []; const sql = { exec() { return {toArray: () => []}; } }; const tunnels = new DeviceTunnels(sql as any, f=>owner.push(f), (_id,f)=>device.push(f),()=>true); tunnels.fromDevice({t:"tun",op:"http.req",sid:"client-made",method:"POST",path:"/mcp"},"client"); assert.equal(owner.length,0); assert.equal(device[0].code,"forbidden"); });
test("gateway close releases a stalled verifier/service acceptFrame promptly", async()=> {const f=await setup(1000);let release!:()=>void;f.service(async(_o,i)=>{await new Promise<void>(r=>release=r);return{version:1,target:i.target,capabilities:[]};});const p=f.start(),fail=assert.rejects(p);const receiving=f.adapter.acceptFrame(await f.sent());for(let n=0;!release&&n<30;n++)await delay(2);f.adapter.close();await receiving;assert.equal(f.adapter.inflight,0);f.client.close();await fail;release();await delay(2);assert.equal(f.qb.length,0);});
test("actual asset service/store commits a full 40KiB chunk via signed relay", async()=> {
  const {mkdtemp,rm,realpath}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{createHash}=await import("node:crypto");
  const {MaterialAssetStore}=await import("../src/collaboration/material-store"),{MaterialTransferService}=await import("../src/collaboration/material-transfer");
  const dir=await mkdtemp(join(await realpath(tmpdir()),"relay-actual-asset-")), f=await setup(2000);
  const source={kind:"work" as const,work:{node_id:"desktop",endpoint_id:"codex",kind:"conversation" as const,native_id:"host-verified-thread"}},destination={kind:"node" as const,node_id:"phone",endpoint_id:"materials"};
  const bytes=Buffer.alloc(40*1024,13),expires_at=Date.now()+60000,sha256=createHash("sha256").update(bytes).digest("hex");
  const issued=new WeakSet<object>();
  const custody={acquireMaintenance:async(storeId:string)=>{assert.equal(storeId,"phone-store");f.binding.current();const lease={descriptor:{version:1 as const,authority_id:"relay-fixture",local_store_id:"phone-store",expires_at:Date.now()+60000}};issued.add(lease);return lease;},currentMaintenance:(lease:any):undefined=>{assert.ok(issued.has(lease));f.binding.current();return undefined;},acquire:async(c:any,s:any,role:any,purpose:any)=>{f.binding.current();assert.equal(c.principal_id,"external-one");assert.equal(c.pairing_id,"pair");assert.deepEqual(c.source_binding,source);assert.equal(role,"destination_transfer");assert.equal(purpose,"wire");assert.equal(s.request_id,"asset-request");assert.deepEqual(s.source,source);assert.deepEqual(s.return_to,source);assert.deepEqual(s.target,destination);assert.deepEqual(s.transfer,{asset_id:"large-chunk",asset_version:1,source,destination});const lease={descriptor:{version:1 as const,custody_id:"registered-relay-slot",authority_id:"relay-fixture",owner_principal_id:"external-one",request_id:"asset-request",asset_id:"large-chunk",asset_version:1,sha256,byte_length:bytes.length,source,destination,local_store_id:"phone-store",expires_at:Math.min(expires_at,c.expires_at)}};issued.add(lease);return lease;},current:(lease:any):undefined=>{assert.ok(issued.has(lease));f.binding.current();return undefined;}};
  const auth={before:async(c:any)=>c,after:async()=>{},current:()=>undefined};const store=new MaterialAssetStore({rootDir:join(dir,"assets"),authorization:auth,custody,localStoreId:"phone-store"});
  try {
    const service=new MaterialTransferService({store,authorization:auth,currentContext:()=>undefined,resolveScope:async(operation,input:any)=>({kind:"request",action:operation,request_id:"asset-request",source,return_to:source,target:destination,transfer:{asset_id:"large-chunk",asset_version:1,source,destination}})});
    f.assetService((o:any,i:any,c:any)=>service.invoke(o,i,c));
    const offer={version:1 as const,request_id:"asset-request",asset:{kind:"asset" as const,asset_id:"large-chunk",version:1,sha256:createHash("sha256").update(bytes).digest("hex"),byte_length:bytes.length,media_type:"image/png",display_name:"fixture.png",provenance:[],expires_at},source,destination,expires_at};
    async function exchange(o:any,i:any){const p=f.client.invokeAsset(o,i,f.binding);await f.adapter.acceptFrame(await f.sent());assert.equal(f.qb.length,1);await f.client.acceptFrame(f.qb.shift());return p;}
    const offered:any=await exchange("offer",offer),identity={version:1,request_id:offered.request_id,transfer_id:offered.transfer_id,asset_id:offered.asset_id,asset_version:offered.asset_version};
    await exchange("put_chunk",{...identity,chunk_index:0,data_base64:bytes.toString("base64")});const committed:any=await exchange("commit",identity);assert.equal(committed.state,"committed");assert.equal(committed.receipt.sha256,offer.asset.sha256);assert.equal(committed.receipt.byte_length,40*1024);
  }finally{f.client.close();f.adapter.close();await store.close();await rm(dir,{recursive:true,force:true});}
});
test("asynchronous signature verification observes revoke/restore generation on receiver",async()=> {
  const f=await setup(200),p=f.start(),fail=assert.rejects(p),e=await f.sent();const original=GatewayClient.verifyEnvelope;
  let release!:()=>void;
  GatewayClient.verifyEnvelope=async(frame,key)=>{const valid=await original(frame,key);await new Promise<void>(r=>release=r);return valid;};
  try{const receiving=f.adapter.acceptFrame(e);for(let n=0;!release&&n<30;n++)await delay(2);f.aba();release();await receiving;assert.equal(f.counts().calls,0);assert.equal(f.qb.length,0);f.client.close();await fail;}
  finally{GatewayClient.verifyEnvelope=original;f.client.close();f.adapter.close();}
});
test("asynchronous response verification cannot return after source binding is revoked",async()=> {
  const f=await setup(200),p=f.start(),fail=assert.rejects(p,{code:"permission_denied"}),e=await f.sent();await f.adapter.acceptFrame(e);const original=GatewayClient.verifyEnvelope;let release!:()=>void;
  GatewayClient.verifyEnvelope=async(frame,key)=>{const valid=await original(frame,key);await new Promise<void>(r=>release=r);return valid;};
  try{const receiving=f.client.acceptFrame(f.qb.shift());for(let n=0;!release&&n<30;n++)await delay(2);f.revoke();release();await receiving;await fail;assert.equal(f.client.inflight,0);}
  finally{GatewayClient.verifyEnvelope=original;f.client.close();f.adapter.close();}
});
test("final asynchronous signing boundary cannot send after transport generation changes",async()=> {
  const f=await setup(200),p=f.start(),fail=assert.rejects(p),e=await f.sent();const original=f.gb.envelope.bind(f.gb);let release!:()=>void;
  f.gb.envelope=async(...args)=>{const signed=await original(...args);await new Promise<void>(r=>release=r);return signed;};
  const receiving=f.adapter.acceptFrame(e);for(let n=0;!release&&n<30;n++)await delay(2);f.aba();release();await receiving;assert.equal(f.qb.length,0);f.client.close();await fail;f.adapter.close();
});
test("unexpired signed replay tombstones survive reconnect; expired entries reclaim capacity", async()=> {
  const f=await setup(80,1);
  const p=f.start(),e=await f.sent();await f.adapter.acceptFrame(e);await f.client.acceptFrame(f.qb.shift());await p;
  f.adapter.invalidate();await f.adapter.acceptFrame(e);assert.equal(f.counts().calls,1);
  const body=JSON.parse(e.payload),blocked=await f.ga.envelope(MATERIAL_REQUEST_TYPE,f.b.id,{...body,call_id:"fresh-blocked-call"},{ttlMs:80});
  await f.adapter.acceptFrame(blocked);assert.equal(f.counts().calls,1);
  await delay(85);await f.adapter.acceptFrame(e);assert.equal(f.counts().calls,1);
  const fresh=await f.ga.envelope(MATERIAL_REQUEST_TYPE,f.b.id,{...body,call_id:"fresh-admitted-call"},{ttlMs:80});await f.adapter.acceptFrame(fresh);assert.equal(f.counts().calls,2);assert.equal(f.qb.length,1);
  await f.adapter.acceptFrame(fresh);assert.equal(f.counts().calls,2);f.client.close();f.adapter.close();
});
test("external authentication is bounded before provider calls and releases failures",async()=> {
  const f=await setup(),waiting:{resolve(v:any):void;reject(e:Error):void;signal:AbortSignal}[]=[];let providerCalls=0;
  const provider={available:()=>["discover" as const],current:()=>undefined,acquire:(signal:AbortSignal)=>{providerCalls++;return new Promise<any>((resolve,reject)=>waiting.push({resolve,reject,signal}));}};
  const tools=new ExternalCollaborationTools(f.client,provider,{maxAuthenticating:2});
  const p1=tools.invoke("discover",f.input),p2=tools.invoke("discover",f.input),failed1=assert.rejects(p1),failed2=assert.rejects(p2);
  assert.equal(tools.authenticating,2);await assert.rejects(tools.invoke("discover",f.input),{code:"too_large"});assert.equal(providerCalls,2);
  waiting[0].reject(new MaterialProtocolError("permission_denied"));await failed1;assert.equal(tools.authenticating,1);
  const p3=tools.invoke("discover",f.input),failed3=assert.rejects(p3,{code:"offline"});assert.equal(providerCalls,3);
  tools.close();await Promise.all([failed2,failed3]);assert.equal(tools.authenticating,2);assert.ok(waiting[1].signal.aborted&&waiting[2].signal.aborted);
  waiting[1].resolve(f.binding);waiting[2].resolve(f.binding);await delay(2);assert.equal(f.counts().sends,0);assert.equal(tools.authenticating,0);f.adapter.close();
});
test("timeout and invalidate retain provider-active capacity until ignored-abort promise settles",async()=> {
  const f=await setup();let calls=0;const waiting:{resolve(v:any):void;signal:AbortSignal}[]=[];
  const provider={available:()=>["discover" as const],current:()=>undefined,acquire:(signal:AbortSignal)=>{calls++;return new Promise<any>(resolve=>waiting.push({resolve,signal}));}};
  const tools=new ExternalCollaborationTools(f.client,provider,{maxAuthenticating:1,budgetMs:20});
  await assert.rejects(tools.invoke("discover",f.input),{code:"timeout"});assert.equal(tools.authenticating,1);assert.ok(waiting[0].signal.aborted);
  for(let n=0;n<5;n++)await assert.rejects(tools.invoke("discover",f.input),{code:"too_large"});assert.equal(calls,1);
  waiting[0].resolve(f.binding);await delay(2);assert.equal(tools.authenticating,0);assert.equal(f.counts().sends,0);
  const next=tools.invoke("discover",f.input),fail=assert.rejects(next,{code:"offline"});assert.equal(calls,2);tools.invalidate();await fail;
  assert.equal(tools.authenticating,1);await assert.rejects(tools.invoke("discover",f.input),{code:"too_large"});assert.equal(calls,2);
  waiting[1].resolve(f.binding);await delay(2);assert.equal(tools.authenticating,0);assert.equal(f.counts().sends,0);
  const fresh=tools.invoke("discover",f.input),freshFail=assert.rejects(fresh,{code:"offline"});assert.equal(calls,3);tools.close();await freshFail;assert.equal(tools.authenticating,1);
  waiting[2].resolve(f.binding);await delay(2);assert.equal(tools.authenticating,0);assert.equal(f.counts().sends,0);f.adapter.close();
});
test("successful authentication releases slot; invalidated late authentication cannot revive",async()=> {
  const f=await setup();const tools=new ExternalCollaborationTools(f.client,{available:()=>["discover"],current:()=>undefined,acquire:async()=>f.binding},{maxAuthenticating:1});
  const p=tools.invoke("discover",f.input),e=await f.sent();assert.equal(tools.authenticating,0);await f.adapter.acceptFrame(e);await f.client.acceptFrame(f.qb.shift());await p;
  tools.close();await assert.rejects(tools.invoke("discover",f.input),{code:"offline"});assert.equal(tools.authenticating,0);f.adapter.close();
});
test("late provider rejection and synchronous acquire failure both reclaim provider capacity",async()=> {
  const f=await setup();let fail!: (error:Error)=>void, calls=0;
  const provider={available:()=>["discover" as const],current:()=>undefined,acquire:(_signal:AbortSignal):Promise<any>=>{calls++;if(calls>1)throw new MaterialProtocolError("permission_denied");return new Promise((_resolve,reject)=>fail=reject);}};
  const tools=new ExternalCollaborationTools(f.client,provider,{maxAuthenticating:1,budgetMs:15});
  await assert.rejects(tools.invoke("discover",f.input),{code:"timeout"});assert.equal(tools.authenticating,1);fail(new MaterialProtocolError("permission_denied"));await delay(2);assert.equal(tools.authenticating,0);
  await assert.rejects(tools.invoke("discover",f.input),{code:"permission_denied"});assert.equal(tools.authenticating,0);assert.equal(calls,2);assert.equal(f.counts().sends,0);tools.close();f.adapter.close();
});

test("raw lifecycle observer retains actual adapter work after observer timeout and close",async()=>{
 const active=new Set<Promise<unknown>>(),observe=(work:Promise<unknown>):undefined=>{active.add(work);work.finally(()=>active.delete(work)).catch(()=>{});return undefined;},f=await setup(30,4096,observe);let release!:()=>void;f.service(async(_o,input)=>{await new Promise<void>(resolve=>{release=resolve;});return {version:1,target:input.target,capabilities:[]};});const pending=f.start(),failed=assert.rejects(pending,{code:'timeout'}),frame=await f.sent(),observed=f.adapter.acceptFrame(frame);for(let n=0;!release&&n<50;n++)await delay(1);assert.ok(release);await observed;await failed;assert.equal(f.adapter.inflight,0);assert.equal(active.size,1);f.adapter.close();assert.equal(active.size,1);release();await Promise.allSettled([...active]);await delay(1);assert.equal(active.size,0);assert.equal(f.qb.length,0);f.client.close();
});
test("raw outgoing capture remains observed after client timeout; rejected registration starts no provider",async()=>{
 const a=await DeviceKey.generate(),b=await DeviceKey.generate(),active=new Set<Promise<unknown>>();let release!:()=>void,captures=0;const transport={async capture(){captures++;await new Promise<void>(resolve=>{release=resolve;});return {local_id:a.id,peer_id:b.id,public_key:b.publicKey,pairing_id:'pair',generation:'1'};},current():undefined{return undefined;},send():undefined{assert.fail('late capture must not send');}},binding={binding_id:'private',current():undefined{return undefined;}},input={version:1 as const,target:{node_id:b.id,endpoint_id:'materials'}},client=new MaterialClient({gateway:new GatewayClient('https://fixture.invalid',a),transport,budgetMs:15,observeUnfinished(work):undefined{active.add(work);work.finally(()=>active.delete(work)).catch(()=>{});return undefined;}});await assert.rejects(client.invoke('discover',input,binding),{code:'timeout'});assert.equal(active.size,1);client.close();release();await Promise.allSettled([...active]);assert.equal(active.size,0);const rejected=new MaterialClient({gateway:new GatewayClient('https://fixture.invalid',a),transport,observeUnfinished():undefined{throw new MaterialProtocolError('too_large');}});await assert.rejects(rejected.invoke('discover',input,binding),{code:'offline'});assert.equal(captures,1);rejected.close();
});

test('immediate client close before raw microtask starts never begins transport capture',async()=>{
 const a=await DeviceKey.generate();let captures=0;const raw:Promise<unknown>[]=[];const client=new MaterialClient({gateway:new GatewayClient('https://fixture.invalid',a),transport:{async capture(){captures++;throw Error('unexpected capture');},current():undefined{return undefined;},send():undefined{return undefined;}},observeUnfinished(work):undefined{raw.push(work);return undefined;}});const pending=client.invoke('discover',{version:1,target:{node_id:'phone',endpoint_id:'materials'}},{binding_id:'private',current():undefined{return undefined;}});client.close();await assert.rejects(pending,{code:'offline'});await Promise.allSettled(raw);assert.equal(captures,0);
});

test('private lifetime replay owner preserves unexpired frames across new adapters without replacing signed current checks',async()=>{
 const owner=new MaterialGatewayReplayOwner(),f=await setup(500,4096,undefined,owner);const pending=f.start(),frame=await f.sent();await f.adapter.acceptFrame(frame);await f.client.acceptFrame(f.qb.shift());await pending;f.adapter.close();const next=new MaterialGatewayAdapter(f.adapterOptions);await next.acceptFrame(frame);assert.equal(f.counts().calls,1);assert.equal(f.qb.length,0);const fresh=await f.ga.envelope(MATERIAL_REQUEST_TYPE,f.b.id,{...JSON.parse(frame.payload),call_id:'new-current-call'},{ttlMs:500});await next.acceptFrame(fresh);assert.equal(f.counts().calls,2);assert.throws(()=>new MaterialGatewayAdapter({...f.adapterOptions,replayOwner:structuredClone(owner)}),{code:'invalid'});next.close();f.client.close();
});
test('binding issuer receives only signature-verified frozen exact operation/input; an old binding cannot choose another asset',async()=>{const f=await setup();let issuers=0,assets=0;const context={principal_id:'receiver-fixture',pairing_id:'pair',grant_revision:'1',authorization_epoch:'1',source_binding:{kind:'node' as const,node_id:f.a.id,endpoint_id:'materials'},expires_at:Date.now()+60000};const adapter=new MaterialGatewayAdapter({...f.adapterOptions,bindings:{async resolve(id,peer,call){issuers++;assert.equal(id,f.binding.binding_id);assert.equal(peer.peer_id,f.a.id);assert.ok(call&&Object.isFrozen(call)&&Object.isFrozen(call.input));if(call.operation!=='offer'||call.input.asset.asset_id!=='registered-asset')throw new MaterialProtocolError('permission_denied');assert.ok(Object.isFrozen(call.input.asset));assert.throws(()=>{(call.input.asset as {asset_id:string}).asset_id='mutated';},TypeError);return {context,current:()=>undefined};}},assets:{invoke:async()=>{assets++;throw new MaterialProtocolError('unsupported');}}});try{const expires_at=Date.now()+60000,input={version:1,request_id:'canonical-input',asset:{kind:'asset',asset_id:'registered-asset',version:1,sha256:'0'.repeat(64),byte_length:0,media_type:'text/plain',display_name:'empty',provenance:[],expires_at},source:{kind:'node',node_id:f.a.id,endpoint_id:'materials'},destination:{kind:'work',work:{node_id:f.b.id,endpoint_id:'codex',kind:'conversation',native_id:'thread'}},expires_at};const signed=await f.ga.envelope(MATERIAL_REQUEST_TYPE,f.b.id,{version:1,call_id:'issuer-call',binding_id:f.binding.binding_id,operation:'offer',input},{ttlMs:500});await adapter.acceptFrame({...signed,sig:'invalid'});assert.equal(issuers,0);const wrong=await f.ga.envelope(MATERIAL_REQUEST_TYPE,f.b.id,{version:1,call_id:'other-call',binding_id:f.binding.binding_id,operation:'offer',input:{...input,asset:{...input.asset,asset_id:'unregistered-asset'}}},{ttlMs:500});await adapter.acceptFrame(wrong);assert.equal(issuers,1);assert.equal(assets,0);await adapter.acceptFrame(signed);assert.equal(issuers,2);assert.equal(assets,1);}finally{adapter.close();f.adapter.close();f.client.close();}});

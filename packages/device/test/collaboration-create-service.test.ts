import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures/create-service-fixture";
import { CollaborationCreateError } from "../src/collaboration/create-types";
import { controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
const code = (...codes:string[]) => (e:unknown) => e instanceof CollaborationCreateError && codes.includes(e.code);
const writes = (f:Awaited<ReturnType<typeof serviceFixture>>) => f.socket.calls.filter(c=>["thread/start","thread/name/set","turn/start"].includes(c.method));
test("actual journal and socket: discovery then three durable stages; reads never write and DTO hides input",async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context); const input=f.apply();
 f.socket.hook=c=>{const s=c.method==="thread/start"?"create":c.method==="thread/name/set"?"name":c.method==="turn/start"?"first_input":null;if(s){const fact=f.store.get("owner","operation")!;assert.equal(fact[s].status,"invoking");if(s==="first_input")assert.equal(c.params.clientUserMessageId,fact.native_client_message_id);}};
 const result=await f.service.execute("apply",input,f.context);assert.ok("fact" in result&&result.fact?.first_input.status==="accepted");assert.equal(writes(f).length,3);assert.equal(JSON.stringify(result).includes('"principal_id"'),false);assert.equal(JSON.stringify(result).includes('"input"'),false);
 const before=f.socket.calls.filter(c=>c.method==="project/list").length;
 await f.service.execute("query",f.lookup(),f.context);await f.service.execute("reconcile",f.lookup(),f.context);assert.equal(writes(f).length,3);assert.equal(f.socket.calls.filter(c=>c.method==="project/list").length,before);
 await f.service.execute("apply",input,f.context);assert.equal(writes(f).length,3);assert.equal(f.stats().constructions,1);
});
for(const mode of ["missing","wrong-owner","unpaired","wrong-cwd","single-work","no-create","wrong-node","wrong-endpoint","revision","expired"])
 test(`pre-init denial ${mode} constructs no native source`,async t=>{
 const f=await serviceFixture(t),body=f.discovery();let context:any=f.context;
 if(mode==="missing")context=undefined;if(mode==="wrong-owner")context={...f.context,transportOwnerId:"other"};if(mode==="unpaired")f.setPaired(null);if(mode==="wrong-cwd")body.cwd="/other";if(mode==="wrong-node")body.node_id="other";if(mode==="wrong-endpoint")body.endpoint_id="other";if(mode==="revision")body.authorization_revision="a".repeat(64);
 if(["single-work","no-create","expired"].includes(mode)){const g=f.getGrant().config!;f.setGrant(controlAuthorizationSnapshot({...g,...(mode==="single-work"?{allowed_actions:["send_input"],scope:{kind:"single_work",work:{node_id:"node",endpoint_id:"endpoint",kind:"conversation",native_id:"thread"}}}:mode==="no-create"?{allowed_actions:["send_input"]}:{expires_at:1})},"endpoint"));body.authorization_revision=f.getGrant().authorization_revision!;}
 await assert.rejects(f.service.execute("projects",body,context),code("permission_denied"));assert.equal(f.stats().constructions,0);assert.equal(f.socket.calls.length,0);
 });
for(const stage of ["thread/start","thread/name/set","turn/start"])
 for(const change of ["revoke","ABA","pairing","expiry","revision","epoch","cwd"])
 test(`${stage} async ${change} prevents stale response and later writes`,async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context);const body=f.apply();
 f.socket.hook=c=>{if(c.method!==stage)return;queueMicrotask(()=>{if(change==="revoke")f.revoke();if(change==="ABA"){const old=f.getGrant();f.revoke();f.authorization.invalidate();f.setGrant(old);}if(change==="pairing")f.setCurrent(false);if(change==="expiry"){f.setGrant(controlAuthorizationSnapshot({...f.getGrant().config!,expires_at:1},"endpoint"));}if(change==="revision")f.setGrant(controlAuthorizationSnapshot({...f.getGrant().config!,authorization_generation:2},"endpoint"));if(change==="epoch")f.native.close();if(change==="cwd")f.socket.cwd="/foreign";});};
 if(change==="cwd"&&stage==="thread/start"){const response=await f.service.execute("apply",body,f.context);assert.ok("fact" in response&&response.fact?.create.status==="unknown"&&response.fact.work===null);}else await assert.rejects(f.service.execute("apply",body,f.context),code("permission_denied","stale_precondition","offline"));const expected=stage==="thread/start"?1:stage==="thread/name/set"?2:3;assert.equal(writes(f).length,expected);const fact=f.store.get("owner","operation")!;assert.equal(fact[stage==="thread/start"?"create":stage==="thread/name/set"?"name":"first_input"].status,"unknown");
 });
test("same operation concurrent requests preserve one native invocation per stage",async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context);const body=f.apply();await Promise.all([f.service.execute("apply",body,f.context),f.service.execute("apply",body,f.context)]);assert.equal(writes(f).length,3);assert.equal(f.stats().constructions,1);
});
test("grant mutates during asynchronous project read; no project data escapes",async t=>{const f=await serviceFixture(t);f.socket.hook=c=>{if(c.method==="project/list")queueMicrotask(()=>f.revoke());};await assert.rejects(f.service.execute("projects",f.discovery(),f.context),code("permission_denied"));assert.equal(writes(f).length,0);});
test("query null requires no connection or native project scan",async t=>{const f=await serviceFixture(t);assert.deepEqual(await f.service.execute("query",f.lookup(),f.context),{fact:null});assert.equal(f.stats().constructions,0);});
test("deadline tracks pending native ownership; close drains connection without daemon shutdown",async t=>{
 const f=await serviceFixture(t,15);await f.service.execute("projects",f.discovery(),f.context);f.socket.fault="thread/start";const body=f.apply();await assert.rejects(f.service.execute("apply",body,f.context),code("result_unknown"));assert.ok(["invoking","unknown"].includes(f.store.get("owner","operation")!.create.status));await f.service.close();assert.equal(f.service.busy,false);assert.equal(f.store.get("owner","operation")!.create.status,"unknown");assert.equal(writes(f).length,1);assert.ok(!f.socket.calls.some(c=>/shutdown|stop|interrupt/.test(c.method)));assert.ok(f.stats().closes>0);
});
test("immutable admission bindings resist caller mutation and manifest never exposes cwd",async t=>{const f=await serviceFixture(t);const body=f.discovery();const pending=f.service.execute("projects",body,f.context);body.cwd="/foreign";const out=await pending;assert.ok("target" in out&&out.target.cwd==="/project");assert.equal(JSON.stringify(f.service.manifest()).includes("/project"),false);});

test("saved query remains available offline with current owner grant; revoke suppresses saved receipts",async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context);await f.service.execute("apply",f.apply(),f.context);f.native.close();const calls=f.socket.calls.length;
 const result=await f.service.execute("query",f.lookup(),f.context);assert.ok("fact" in result&&result.fact?.first_input.status==="accepted");assert.equal(f.socket.calls.length,calls);
 const old=f.lookup();f.revoke();await assert.rejects(f.service.execute("query",old,f.context),code("permission_denied"));assert.equal(f.socket.calls.length,calls);
});
test("unknown query and retransmission never reconnect or scan projects",async t=>{
 const f=await serviceFixture(t,20);await f.service.execute("projects",f.discovery(),f.context);const body=f.apply();f.socket.fault="thread/start";await assert.rejects(f.service.execute("apply",body,f.context),code("result_unknown"));
 for(let i=0;i<10&&f.service.busy;i++)await new Promise(r=>setTimeout(r,1));const calls=f.socket.calls.length;
 const queried=await f.service.execute("query",f.lookup(),f.context);assert.ok("fact" in queried&&queried.fact?.create.status==="unknown");const applied=await f.service.execute("apply",body,f.context);assert.ok("fact" in applied&&applied.fact?.create.status==="unknown");assert.equal(f.socket.calls.length,calls);
});
test("native initialization is blocked if source factory synchronously revokes current grant",async t=>{
 const f=await serviceFixture(t);const oldNative=(f.service as any).options.native;(f.service as any).options.native=()=>{const n=oldNative();f.revoke();return n;};await assert.rejects(f.service.execute("projects",f.discovery(),f.context),code("permission_denied"));assert.equal(f.socket.calls.length,0);
});
test("actual grant expiry with unchanged revision invalidates admitted lease",async t=>{
 const f=await serviceFixture(t),expiry=Date.now()+50000;f.setGrant(controlAuthorizationSnapshot({...f.getGrant().config!,expires_at:expiry},"endpoint"));await f.service.execute("projects",f.discovery(),f.context);const body=f.apply();f.socket.hook=c=>{if(c.method==="thread/name/set")queueMicrotask(()=>f.setNow(expiry));};await assert.rejects(f.service.execute("apply",body,f.context),code("permission_denied"));assert.equal(writes(f).length,2);
});

test("concurrent request leases are isolated when one transport context loses currentness",async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context);
 let firstCurrent=true;const firstContext={transportOwnerId:"owner",isCurrent:()=>firstCurrent};const first=f.apply(),second=f.apply();second.request={...second.request,operation_id:"other",request_id:"other-request"};let starts=0;
 f.socket.hook=c=>{if(c.method==="thread/start"&&++starts===1)queueMicrotask(()=>{firstCurrent=false;});};
 const [one,two]=await Promise.allSettled([f.service.execute("apply",first,firstContext),f.service.execute("apply",second,f.context)]);
 assert.equal(one.status,"rejected");if(one.status==="rejected")assert.ok(code("permission_denied")(one.reason));assert.equal(two.status,"fulfilled");if(two.status==="fulfilled")assert.ok("fact" in two.value&&two.value.fact?.first_input.status==="accepted");assert.equal(f.store.get("owner","operation")!.create.status,"unknown");assert.equal(f.store.get("owner","other")!.first_input.status,"accepted");
});
test("apply request snapshot cannot be retargeted by caller mutation while native waits",async t=>{
 const f=await serviceFixture(t);await f.service.execute("projects",f.discovery(),f.context);const body=f.apply();
 f.socket.hook=c=>{if(c.method==="thread/start"){body.request.target.cwd="/foreign";body.request.title="Altered";body.request.input.text="Altered";}};
 const response=await f.service.execute("apply",body,f.context);assert.ok("fact" in response&&response.fact?.target.cwd==="/project");assert.equal(f.socket.calls.find(c=>c.method==="thread/name/set").params.name,"Title");assert.equal(f.socket.calls.find(c=>c.method==="turn/start").params.input[0].text,"first");
});

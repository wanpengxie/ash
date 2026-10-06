import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHost, type AgentStream } from "../src/agents/host";
import { RemoteAgents } from "../src/agents/remote";
import type { OpenOptions } from "../src/agents/types";

class Pipe implements AgentStream {
  peer!: Pipe; message?: (message: string | Uint8Array) => void; closer?: (result:{code:number;reason:string})=>void;
  filter = (_frame: any) => true; ended = false;
  send(text: string) { if(this.ended)throw new Error("closed");if(this.filter(JSON.parse(text)))queueMicrotask(()=>{if(!this.peer.ended)this.peer.message?.(text);}); }
  close(code=1000,reason="closed") { if(this.ended)return;this.ended=true;this.closer?.({code,reason});this.peer.close(code,reason); }
  onMessage(cb:(message:string|Uint8Array)=>void){this.message=cb;return()=>{this.message=undefined;};}
  onClose(cb:(result:{code:number;reason:string})=>void){this.closer=cb;return()=>{this.closer=undefined;};}
}
async function until(check:()=>boolean) { for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail("not ready"); }
function attach(host:AgentHost,remote:RemoteAgents){const a=new Pipe(),b=new Pipe();a.peer=b;b.peer=a;host.attach(a);remote.attach(b);return{device:a,phone:b};}

test("remote reconnect retries only in the same epoch and does not repeat a turn",async t=>{
  const state=await mkdtemp(join(tmpdir(),"ash-remote-"));let options!:OpenOptions;let sends=0;
  const factory=async(_kind:unknown,o:OpenOptions)=>{options=o;return {async send(turn:string){sends++;o.onEvent({type:"turn_started",turn});},async steer(){return true;},async interrupt(){},async select(){},async close(){}};};
  const host=new AgentHost(state,state,factory);const events:any[]=[];let calls=0;
  const remote=new RemoteAgents({event:e=>events.push(e),outbound:async()=>{calls++;return{ok:true};}});
  t.after(async()=>{remote.close();await host.close();});let pipes=attach(host,remote);await until(()=>remote.connected);
  const session=await remote.op("open",{kind:"codex"});
  pipes.device.filter=frame=>{if(frame.type==="op_result"){pipes.device.close();return false;}return true;};
  const accepted=remote.op("send",{turn:"one",text:"hello"},session);await until(()=>sends===1&&!remote.connected);
  pipes=attach(host,remote);await accepted;assert.equal(sends,1);
  const tool=options.onOutbound({turn:"one",requestId:"call",tool:"agent_list",args:{}});assert.deepEqual(await tool,{ok:true});assert.equal(calls,1);
  pipes.device.send(JSON.stringify({type:"event",session:session.session,generation:"wrong",event:{type:"note",turn:"one",text:"WRONG"}}));
  options.onEvent({type:"turn_ended",turn:"one",outcome:"ok",reply:"done"});await until(()=>events.some(e=>e.event.type==="turn_ended"));
  assert.ok(!events.some(e=>e.event.text==="WRONG"));
  pipes.device.filter=frame=>{if(frame.type==="op_result"){pipes.device.close();return false;}return true;};
  const unknown=assert.rejects(remote.op("send",{turn:"two",text:"hello"},session),/result_unknown.*restarted/);await until(()=>sends===2&&!remote.connected);
  const restarted=new AgentHost(state,state,factory);t.after(()=>restarted.close());attach(restarted,remote);await unknown;
  assert.equal(sends,2);
});

test("remote does not grant a stale session's outbound request the next turn's identity",async t=>{
  const state=await mkdtemp(join(tmpdir(),"ash-remote-"));let options!:OpenOptions;let calls=0;
  const host=new AgentHost(state,state,async(_kind,o)=>{options=o;return{async send(){},async steer(){return true;},async interrupt(){},async select(){},async close(){}}});
  const remote=new RemoteAgents({event(){},outbound:async()=>{calls++;return{};}});t.after(async()=>{remote.close();await host.close();});
  const pipes=attach(host,remote);await until(()=>remote.connected);const session=await remote.op("open",{kind:"codex"});
  await remote.op("send",{turn:"one",text:"hello"},session);options.onEvent({type:"turn_ended",turn:"one",outcome:"ok",reply:"done"});await delay(5);
  await remote.op("send",{turn:"two",text:"hello"},session);
  pipes.device.send(JSON.stringify({type:"outbound",...session,turn:"one",request_id:"late",tool:"agent_ask",args:{agent:"agent:main",text:"wrong turn"}}));await delay(10);
  assert.equal(calls,0);
});

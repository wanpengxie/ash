import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHost, type AgentStream } from "../src/agents/host";
import type { OpenOptions, AgentSession } from "../src/agents/types";

class Stream implements AgentStream {
  sent: any[] = []; message?: (message: string) => void; closer?: (result: {code:number;reason:string}) => void;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close(code = 1000, reason = "closed") { this.closer?.({code,reason}); }
  onMessage(cb: (message: string | Uint8Array) => void) { this.message = cb; return () => { this.message = undefined; }; }
  onClose(cb: (result: {code:number;reason:string}) => void) { this.closer = cb; return () => { this.closer = undefined; }; }
  input(frame: object) { this.message?.(JSON.stringify(frame)); }
  async result(id: string) { for (let i = 0; i < 100; i++) { const result = this.sent.find(f => f.id === id); if(result)return result; await delay(5); } throw new Error("no result"); }
}

test("host deduplicates accepted sends, survives disconnect, persists full result and fences restarts", async t => {
  const state = await mkdtemp(join(tmpdir(), "ash-agent-host-"));
  let options!: OpenOptions; let sends = 0; let opens = 0;
  const factory = async (_kind: unknown, o: OpenOptions): Promise<AgentSession> => {
    options = o; opens++; o.onEvent({ type: "seed_updated", seed: "saved-seed" });
    return { async send(turn) { sends++; o.onEvent({ type:"turn_started",turn }); }, async steer() { return true; }, async interrupt() {}, async select() {}, async close() { o.onEvent({type:"ended",reason:"closed"}); } };
  };
  const host = new AgentHost(state, state, factory); t.after(() => host.close());
  let stream = new Stream(); host.attach(stream); stream.input({type:"hello",epoch:"phone-1"});
  stream.input({type:"op",epoch:host.epoch,id:"open",op:"open",args:{kind:"codex"}});
  const opened = (await stream.result("open")).result;
  const base = {type:"op",epoch:host.epoch,session:opened.session,generation:opened.generation};
  const start = {...base,id:"send",op:"send",args:{turn:"turn-1",text:"hello"}};
  stream.input(start); await stream.result("send"); stream.input(start); await delay(10); assert.equal(sends,1);
  stream.close(); stream = new Stream(); host.attach(stream); stream.input({type:"hello",epoch:"phone-1"}); stream.input(start); await stream.result("send"); assert.equal(sends,1);
  assert.ok(stream.sent.some(f => f.type === "event" && f.event.type === "turn_started"));
  const late = options.onOutbound({turn:"turn-1",requestId:"native",tool:"agent_list",args:{}});
  const outbound = stream.sent.find(f => f.type === "outbound"); assert.equal(outbound.turn,"turn-1");
  stream.input({...outbound,type:"outbound_result",generation:"wrong",ok:true,result:{wrong:true}});
  stream.input({...outbound,type:"outbound_result",ok:true,result:{agents:[]}});
  assert.deepEqual(await late,{agents:[]});
  stream.close();
  options.onEvent({type:"note",turn:"turn-1",kind:"text",text:'token="secret-test"'});
  options.onEvent({type:"turn_ended",turn:"turn-1",outcome:"ok",reply:"结果🙂".repeat(30_000)});
  stream = new Stream(); host.attach(stream); stream.input({type:"hello",epoch:"phone-1"});
  stream.input({...base,id:"query",op:"result",args:{turn:"turn-1"}});
  const result = (await stream.result("query")).result.event;
  assert.equal(result.truncated,true); assert.equal(await readFile(result.reply_path,"utf8"),"结果🙂".repeat(30_000));
  stream.input({...base,id:"repeat-turn",op:"send",args:{turn:"turn-1",text:"don't repeat"}});
  assert.equal((await stream.result("repeat-turn")).ok,false); assert.equal(sends,1);
  stream.input({...base,id:"clear",op:"clear",args:{}}); const nextGeneration=(await stream.result("clear")).result.generation;
  assert.notEqual(nextGeneration,opened.generation); assert.equal(opens,2);
  stream.input({...base,id:"stale",op:"send",args:{turn:"turn-2",text:"stale"}}); assert.equal((await stream.result("stale")).ok,false);
  await host.close();
  const restarted = new AgentHost(state,state,factory); t.after(()=>restarted.close());
  stream = new Stream(); restarted.attach(stream); stream.input({type:"hello",epoch:"phone-1"}); stream.input(start);
  assert.equal((await stream.result("send")).error.code,"result_unknown"); assert.equal(sends,1);
  stream.input({...base,epoch:restarted.epoch,id:"recover-result",op:"result",args:{turn:"turn-1"}});
  assert.equal((await stream.result("recover-result")).result.event.outcome,"ok");
});

test("host closes stale outbound on turn end, sanitizes progress and rejects reused op IDs", async t => {
  const state=await mkdtemp(join(tmpdir(),"ash-agent-host-")); let options!:OpenOptions;
  const host=new AgentHost(state,state,async(_kind,o)=>{options=o;return{async send(){},async steer(){return true;},async interrupt(){},async select(){},async close(){}}}); t.after(()=>host.close());
  const stream=new Stream();host.attach(stream);stream.input({type:"hello",epoch:"phone"});
  stream.input({type:"op",epoch:host.epoch,id:"open",op:"open",args:{kind:"claude"}});const opened=(await stream.result("open")).result;
  const base={type:"op",epoch:host.epoch,session:opened.session,generation:opened.generation};
  stream.input({...base,id:"send",op:"send",args:{turn:"t1",text:"hello"}});await stream.result("send");
  options.onEvent({type:"note",turn:"t1",kind:"text",text:'authorization: Bearer sensitive-test '+"🙂".repeat(5000)});
  const note=stream.sent.find(f=>f.event?.type==="note").event.text;
  assert.ok(!note.includes("sensitive-test"));assert.ok(Buffer.byteLength(note)<=4096);assert.ok(!note.includes("�"));
  const pending=options.onOutbound({turn:"t1",requestId:"1",tool:"agent_list",args:{}});
  const rejected=assert.rejects(pending,/turn ended/);
  options.onEvent({type:"turn_ended",turn:"t1",outcome:"ok",reply:"done"});await rejected;
  stream.input({...base,id:"send",op:"send",args:{turn:"t2",text:"reused id"}});await delay(10);
  assert.ok(stream.sent.some(f=>f.id==="send"&&f.error?.code==="invalid"));
});

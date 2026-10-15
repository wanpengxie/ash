import assert from "node:assert/strict";
import test from "node:test";
import type { Caller, HandleContext, Message, Outgoing, Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { wordContract } from "../../../../sdk/src/words";
import { checkChatCard } from "../../../../sdk/src/card";
import { Ledger } from "../../../src/kernel/ledger";
import { TasksService, TASKS_ID, type Task } from "../../../src/services/tasks";
import { cardOf, followUpAt, parseTime } from "../../../src/services/tasks/cards";
import { openLedger } from "../../kernel/ledger/helpers";

const OWNER: Caller={member:"person:owner",via:"human",local:true};
const AGENT: Caller={member:"agent:main",via:"agent",local:true};
const SELF: Caller={member:TASKS_ID,via:"service",local:true};
const T0=new Date(2026,9,15,12).getTime();
function setup(ledger=openLedger().ledger){
  let now=T0;let seq=0; let fail=false; let failUpdates=false;
  const sent:{msg:Outgoing;caller:Caller}[]=[];
  const timers=new Map<string,any>(); const cards=new Set<string>();
  const router={send:async(msg:Outgoing,caller:Caller):Promise<Reply>=>{
    sent.push({msg,caller});const b=msg.body as any;
    if(msg.to==="service:agents")return {ok:true,result:{data:{agents:[{id:"agent:main",primary:true}]}}};
    if(msg.to==="service:clock"){
      if(msg.word==="list")return {ok:true,result:{data:{timers:[...timers.values()]}}};
      if(msg.word==="cancel")timers.delete(b.id);
      if(msg.word==="set"){const id=`timer-${++seq}`;timers.set(id,{id,...b,created_by:caller.member});return {ok:true,result:{data:{id}}};}
    }
    if(msg.word==="card.update"&&failUpdates)return {ok:false,error:{code:"unavailable",message:"temporarily unavailable"}};
    if(msg.word==="show"){
      if(fail)return {ok:false,error:{code:"offline",message:"temporarily away"}};
      const plan=checkChatCard(b.a2ui);
      assert.deepEqual(plan.problems,[],JSON.stringify(plan.problems));
      if(cards.has(b.id))return {ok:false,error:{code:"conflict",message:"same card"}};
      cards.add(b.id);
    }
    return {ok:true,result:{data:{accepted:true}}};
  }};
  const service=new TasksService({ledger,router,now:()=>now});
  const call=async(word:string,body:Record<string,unknown>={},caller=OWNER):Promise<any>=>{
    const contract=wordContract(TASKS_ID,word)!;
    assert.ok(compileSchema(contract.input_schema)(body),`${word} input`);
    const result=await service.handle({id:`m${++seq}`,ts:now,seq,from:caller.member,to:TASKS_ID,kind:"request",word,body} as Message,{caller,raw:body,signal:new AbortController().signal} as HandleContext);
    if(contract.result_schema)assert.ok(compileSchema(contract.result_schema)(result.data),`${word} output`);
    return result.data;
  };
  return{service,call,sent,timers,cards,ledger,advance:(ms:number)=>{now+=ms;},setNow:(ms:number)=>{now=ms;},fail:(v:boolean)=>{fail=v;},failUpdates:(v:boolean)=>{failUpdates=v;}};
}

test("durable add, shared subject/assignee, source and idempotent retry",async()=>{
  const opened=openLedger();const w=setup(opened.ledger);
  const source=w.ledger.append({from:OWNER.member,to:AGENT.member,kind:"request",word:"say",body:{text:"提醒我周四晚上交材料"}});
  const input={title:"交材料",remind_at:T0+1000,due_at:T0+2000,client_id:"capture-1",source:{message:source.id}};
  const {task}=await w.call("add",input,AGENT);
  assert.equal(task.subject,"owner");assert.equal(task.assignee,OWNER.member);
  assert.equal(task.source.message,source.id);
  assert.equal((await w.call("add",input,AGENT)).created,false);
  assert.equal((await w.call("add",Object.fromEntries(Object.entries(input).reverse()),AGENT)).created,false);
  await assert.rejects(w.call("add",{...input,title:"另一个任务"},AGENT),{code:"conflict"});
  assert.equal((await w.call("list")).tasks.length,1);
  w.ledger.close();const reopened=Ledger.open(opened.path);
  try{const after=setup(reopened);await after.service.start();assert.deepEqual((await after.call("get",{id:task.id})).task,task);assert.ok([...after.timers.values()].some(t=>t.word==="task.due"));}finally{reopened.close();}
});

test("reminder and overdue follow-up run once; reschedule rejects old alarm and completion cancels timers",async()=>{
  const w=setup();const {task}=await w.call("add",{title:"交材料",remind_at:T0+1000,due_at:T0+2000});
  w.setNow(T0+1000);await w.call("task.due",{id:task.id,kind:"remind",at:T0+1000},SELF);
  const shows=()=>w.sent.filter(s=>s.msg.word==="show");const count=shows().length;
  await w.call("task.due",{id:task.id,kind:"remind",at:T0+1000},SELF);assert.equal(shows().length,count);
  const next=followUpAt(task)!;w.setNow(next);await w.call("task.due",{id:task.id,kind:"due",at:next},SELF);
  const followed=shows().length;
  await w.call("task.due",{id:task.id,kind:"due",at:next},SELF);await w.call("task.sync",{},SELF);assert.equal(shows().length,followed);
  await w.call("update",{id:task.id,remind_at:next+5000,due_at:next+6000});
  await w.call("task.due",{id:task.id,kind:"remind",at:T0+1000},SELF);assert.equal(shows().length,followed);
  await w.call("done",{id:task.id});assert.ok(![...w.timers.values()].some(t=>t.body.id===task.id));
  w.advance(10000);await w.call("task.due",{id:task.id,kind:"remind",at:next+5000},SELF);assert.equal(shows().length,followed);
  assert.equal((await w.call("list",{status:"closed"})).tasks[0].status,"done");
});

test("failed delivery is kept; completing while disconnected suppresses stale reminder",async()=>{
  const w=setup();w.fail(true);const {task}=await w.call("add",{title:"不要误催",remind_at:T0+1000});
  w.setNow(T0+1000);await w.call("task.due",{id:task.id,kind:"remind",at:T0+1000},SELF);
  assert.equal(w.cards.size,0);
  assert.ok(!(await w.call("get",{id:task.id})).changes.some((c:any)=>c.change==="reminded"),"queued is not delivered");
  await w.call("done",{id:task.id});w.fail(false);await w.call("task.sync",{},SELF);
  assert.ok(![...w.cards].some(id=>id.includes(".remind.")));
  assert.ok([...w.cards].some(id=>id.includes(".noted.")));
});

test("Ash work uses the same store, wakes assignee, reports result at the source and done twice is harmless",async()=>{
  const w=setup();const source=w.ledger.append({from:OWNER.member,to:AGENT.member,kind:"request",word:"say",body:{text:"帮我查材料"}});
  const {task}=await w.call("add",{title:"我查材料",subject:"ash",assignee:"agent:helper",source:{message:source.id},remind_at:T0+1000},AGENT);
  assert.equal((await w.call("list",{subject:"ash"})).tasks[0].id,task.id);
  await assert.rejects(w.call("done",{id:task.id},AGENT),{code:"bad_request"});
  await assert.rejects(w.call("update",{id:task.id,status:"waiting"},AGENT),{code:"bad_request"});
  w.setNow(T0+1000);await w.call("task.due",{id:task.id,kind:"remind",at:T0+1000},SELF);
  assert.ok(w.sent.some(s=>s.msg.to==="agent:helper"&&s.msg.word==="wake"));
  await w.call("done",{id:task.id,result:"材料已找到"},AGENT);
  const report=w.sent.filter(s=>(s.msg.body as any)?.id?.includes(".report."));
  assert.equal(report.length,1);assert.equal(report[0].msg.reply_to,source.id);
  assert.ok(JSON.stringify(report[0].msg.body).includes("材料已找到"));
  await w.call("done",{id:task.id,result:"材料已找到"},AGENT);
  assert.equal(w.sent.filter(s=>(s.msg.body as any)?.id?.includes(".report.")).length,1);
});

test("time validation, cards and equal-timestamp paging",async()=>{
  assert.throws(()=>parseTime(NaN,"due_at"),{code:"bad_request"});assert.throws(()=>parseTime("2026-02-30","due_at"),{code:"bad_request"});
  const w=setup();const ids=[];for(let i=0;i<5;i++)ids.push((await w.call("add",{title:`事 ${i}`,remind_at:T0+(5-i)*1000})).task.id);
  const a=await w.call("list",{limit:2});const b=await w.call("list",{limit:2,before:a.next_before});const c=await w.call("list",{limit:2,before:b.next_before});
  assert.equal(new Set([...a.tasks,...b.tasks,...c.tasks].map((t:Task)=>t.id)).size,5);
  for(const kind of ["noted","remind","follow"] as const)assert.deepEqual(checkChatCard(cardOf(a.tasks[0],kind,T0,"agent:main").a2ui).problems,[]);
  await assert.rejects(w.call("task.due",{id:ids[0],kind:"remind",at:T0+1000},OWNER),{code:"forbidden"});
});


test("a task card update refused temporarily is repaired by the next clock sync",async()=>{
  const w=setup();const {task}=await w.call("add",{title:"原内容"});
  w.failUpdates(true);
  await w.call("update",{id:task.id,title:"新内容"});
  assert.equal((await w.call("get",{id:task.id})).task.title,"新内容");
  const count=w.sent.filter(s=>s.msg.word==="card.update").length;
  w.failUpdates(false);await w.call("task.sync",{},SELF);
  const updates=w.sent.filter(s=>s.msg.word==="card.update");
  assert.equal(updates.length,count+1);
  assert.ok(JSON.stringify(updates.at(-1)!.msg.body).includes("新内容"));
  await w.call("task.sync",{},SELF);
  assert.equal(w.sent.filter(s=>s.msg.word==="card.update").length,updates.length,"does not keep redrawing unchanged cards");
});

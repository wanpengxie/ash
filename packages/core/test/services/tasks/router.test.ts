import assert from "node:assert/strict";
import test from "node:test";
import { TasksService, TASKS_ID } from "../../../src/services/tasks";
import { createClockService } from "../../../src/services/clock";
import { WordError, type Caller } from "../../../../sdk/src/message";
import { wordsOf } from "../../../../sdk/src/words";
import { agent, fake, fakeAgent, owner, service, success, world } from "../../kernel/router/world";
import { eventually } from "../../fixtures/wait";

function taskHub() {
  const w=world({review:"allow"});
  const faults={list:false,set:false,show:false};
  const realClock=createClockService({ledger:w.ledger,router:w.router,now:()=>w.clock.now,setTimer:()=>()=>{},log:()=>{}});
  w.registry.add({id:realClock.id,kind:realClock.kind,name:realClock.name,words:()=>realClock.words(),handle:(m,c)=>{
    if((m.word==="list"&&faults.list)||(m.word==="set"&&faults.set))throw new WordError("unavailable",`injected clock/${m.word} failure`);
    return realClock.handle(m,c);
  }});
  w.registry.add(fake("service:agents",wordsOf("service:agents"),()=>({data:{agents:[{id:"agent:main",primary:true}]}})));
  const shown:string[]=[];
  w.owner.handler=(m)=>{
    if(m.word==="card.update"&&faults.show)throw new WordError("offline","injected conversation outage");
    if(m.word==="show"){
      if(faults.show)throw new WordError("offline","injected conversation outage");
      const id=(m.body as any).id;if(shown.includes(id))throw new WordError("conflict","already shown");shown.push(id);
    }
    return {data:{accepted:true}};
  };
  const helper=fakeAgent("helper");w.registry.add(helper);
  const tasks=new TasksService({ledger:w.ledger,router:w.router,now:()=>w.clock.now});w.registry.add(tasks);
  const call=(word:string,body:Record<string,unknown>={},caller:Caller=owner)=>w.router.send({to:TASKS_ID,kind:"request",word,body},caller);
  return {...w,tasks,realClock,faults,shown,call,helper};
}

test("saved task survives clock/list and clock/set failures without reporting an unsaved failure",async t=>{
  for(const fault of ["list","set"] as const){
    const w=taskHub();t.after(()=>w.realClock.stop());await w.tasks.start();
    w.faults[fault]=true;
    const result=await w.call("add",{title:`clock ${fault}`,remind_at:w.clock.now+10000,client_id:`fault-${fault}`});
    assert.equal(result.ok,true,`${fault}: ${JSON.stringify(result)}`);
    const added=success(result);
    assert.equal(added.task.delivery.saved,true);
    assert.equal(added.task.delivery.reminders,"pending");
    assert.equal(added.task.delivery.conversation,"ready");
    const again=success(await w.call("add",{title:`clock ${fault}`,remind_at:w.clock.now+10000,client_id:`fault-${fault}`}));
    assert.equal(again.created,false);assert.equal(again.task.id,added.task.id);
    w.faults[fault]=false;
    // No direct repair call: the real pre-existing maintenance alarm must perform recovery.
    w.clock.now+=60_001;w.realClock.check();
    await eventually(async()=>success(await w.call("get",{id:added.task.id})).task.delivery.reminders==="ready","the real maintenance alarm restored scheduling");
    assert.ok(w.owner.calls.some(c=>c.msg.word==="card.update"&&!JSON.stringify(c.msg.body).includes("reminder.retry")),"the original card loses its pending reminder warning");
    w.clock.now+=1001;w.realClock.check();
    await eventually(()=>w.shown.some(id=>id.includes(".remind.")),"real clock delivered the recovered reminder");
    assert.equal(success(await w.call("list")).tasks.length,1);
  }
});

test("a lost response reuses the same turn capture, but a later turn may create a new task",async t=>{
  const w=taskHub();t.after(()=>w.realClock.stop());await w.tasks.start();
  const source=w.ledger.append({from:"person:owner",to:"agent:main",kind:"request",word:"say",body:{text:"提醒我交材料"}});
  const input={title:"交材料",source:{message:source.id},remind_at:w.clock.now+10000};
  const first=success(await w.call("add",input,agent("main","capture-turn"))); // The client loses this success reply.
  const second=success(await w.call("add",input,agent("main","capture-turn")));
  assert.equal(second.created,false);assert.equal(second.task.id,first.task.id);
  assert.equal(success(await w.call("list")).tasks.length,1);
  const separate=success(await w.call("add",input,agent("main","new-turn")));
  assert.equal(separate.created,true);assert.notEqual(separate.task.id,first.task.id);
  w.faults.show=true;
  const changed=success(await w.call("update",{id:first.task.id,title:"交报税材料"}));
  assert.equal(changed.task.delivery.saved,true);assert.equal(changed.task.delivery.conversation,"pending");
  w.faults.show=false;await w.call("task.sync",{},service("tasks"));
  assert.equal(success(await w.call("get",{id:first.task.id})).task.delivery.conversation,"ready");
});

test("agent responsibility requires results independently of subject, without automatically starting a named task",async t=>{
  const w=taskHub();t.after(()=>w.realClock.stop());await w.tasks.start();
  const source=w.ledger.append({from:"person:owner",to:"agent:main",kind:"request",word:"say",body:{text:"材料是我的事，让帮手负责"}});
  const added=success(await w.call("add",{title:"核对材料",subject:"owner",assignee:"agent:helper",source:{message:source.id},client_id:"owner-helper"}));
  assert.equal(added.task.status,"todo");assert.equal(w.helper.inbox.length,0);
  await w.call("update",{id:added.task.id,assignee:"agent:main",status:"doing"});
  assert.equal(w.main.inbox.length,0,"a status edit does not dispatch work");
  await w.call("update",{id:added.task.id,assignee:"agent:helper",status:"todo"});
  assert.equal(w.helper.inbox.length,0,"changing the named assignee does not dispatch work");
  const empty=await w.call("done",{id:added.task.id},agent("helper","helper-turn"));
  assert.equal(empty.ok,false,"agent completion must not silently accept an empty result because subject is owner");
  const done=success(await w.call("done",{id:added.task.id,result:"材料已核对"},agent("helper","helper-turn")));
  assert.equal(done.task.subject,"owner");assert.equal(done.task.assignee,"agent:helper");
  assert.ok(w.owner.calls.some(c=>c.msg.word==="show"&&c.msg.reply_to===source.id&&String((c.msg.body as any).id).includes(".report.")));
});


test("first boot with no maintenance timer gives a visible same-task retry instead of an automatic-recovery promise",async t=>{
  for(const fault of ["list","set"] as const){
    const w=taskHub();t.after(()=>w.realClock.stop());w.faults[fault]=true;await w.tasks.start();
    const added=success(await w.call("add",{title:"首次启动要交材料",remind_at:w.clock.now+10_000,client_id:`first-${fault}`}));
    assert.equal(added.task.delivery.saved,true);assert.equal(added.task.delivery.reminders,"pending");
    const confirmation=w.owner.calls.find(c=>c.msg.word==="show")!;
    assert.ok(String((confirmation.msg.body as any).text).includes("提醒尚未安排"));
    assert.ok(JSON.stringify(confirmation.msg.body).includes("重试提醒"));
    w.faults[fault]=false;
    const retry=success(await w.call("update",{id:added.task.id})); // The card and list use this existing word.
    assert.equal(retry.task.id,added.task.id);assert.equal(retry.task.delivery.reminders,"ready");
    assert.equal(success(await w.call("list")).tasks.length,1);
    w.clock.now+=10_001;w.realClock.check();
    await eventually(()=>w.shown.some(id=>id.includes(".remind.")),"the initially unavailable clock now delivered the reminder");
  }
});

/** Deterministic acceptance: the driver follows a fixed script, no model and no wall-clock deadlines. */
import assert from "node:assert/strict";
import test from "node:test";
import { startScenario, byOwnerText, accepted, dataOf, resultOf, bodyOf, toOwner } from "./harness";
import { eventually } from "../fixtures/wait";

test("task acceptance: capture in conversation → reminder → owner completes on its card",async(t)=>{
  const s=await startScenario(t,{fakeNow:true,runtimes:["scripted"]});
  let task:any;
  s.driver.script(byOwnerText({"提醒我周四晚上交材料":async turn=>{
    const result=await turn.call("service:tasks","add",{title:"交材料",subject:"owner",remind_at:s.clock.t+10_000,client_id:"materials"});
    assert.equal(result.isError,false,JSON.stringify(result));task=resultOf(result).task;
  }}));
  const owner=await s.human();accepted(await owner.say("提醒我周四晚上交材料"));
  await eventually(()=>task,"captured task");
  const confirm=await owner.seen(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).text).includes("记下了"),"confirmation");
  assert.ok(task.source?.message,"automatically keeps the owner's source message");
  const card=bodyOf(confirm).id as string;
  const edit=await owner.call("service:cards","act",{card,component:"f.save",data:{title:"交报税材料",remind:"",editing:true}});
  assert.ok(edit.ok,JSON.stringify(edit));assert.equal(dataOf(edit).state,"ok",JSON.stringify(edit));
  assert.equal(dataOf(await owner.call("service:tasks","get",{id:task.id})).task.title,"交报税材料");
  // Clear reminder then reschedule through the same API: stale clock messages are ignored.
  assert.ok((await owner.call("service:tasks","update",{id:task.id,remind_at:s.clock.t+10_000})).ok);
  s.advance(10_001);s.hostEvent({event:"wake.fired",at:s.clock.t});
  const reminder=await owner.seen(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".remind."),"reminder card");
  const done=await owner.call("service:cards","act",{card:bodyOf(reminder).id,component:"done"});
  assert.ok(done.ok,JSON.stringify(done));assert.equal(dataOf(done).state,"ok",JSON.stringify(done));
  assert.equal(dataOf(await owner.call("service:tasks","get",{id:task.id})).task.status,"done");
});

test("task acceptance: Ash promise is shared with Ash screen and result replies at the source",async(t)=>{
  const s=await startScenario(t,{fakeNow:true,runtimes:["scripted"]});let task:any;
  s.driver.script(byOwnerText({"帮我核对材料":async turn=>{
    const added=await turn.call("service:tasks","add",{title:"核对材料",subject:"ash",status:"doing",client_id:"ash-materials"});
    assert.equal(added.isError,false,JSON.stringify(added));task=resultOf(added).task;
  },"核对完了":async turn=>{
    const done=await turn.call("service:tasks","done",{id:task.id,result:"材料齐全，差一份签字"});assert.equal(done.isError,false,JSON.stringify(done));
  }}));
  const owner=await s.human();accepted(await owner.say("帮我核对材料"));await eventually(()=>task,"Ash task captured");
  assert.equal(dataOf(await owner.call("service:tasks","list",{subject:"ash"})).tasks[0].id,task.id);
  accepted(await owner.say("核对完了"));
  const report=await owner.seen(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".report."),"result in conversation");
  assert.equal(report.reply_to,task.source.message);
  assert.ok(String(bodyOf(report).text).includes("差一份签字"));
  assert.equal(dataOf(await owner.call("service:tasks","list",{subject:"ash",status:"closed"})).tasks[0].status,"done");
});

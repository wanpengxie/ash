/** Deterministic acceptance: the driver follows a fixed script, no model and no wall-clock deadlines. */
import assert from "node:assert/strict";
import test from "node:test";
import { startScenario, byOwnerText, accepted, dataOf, resultOf, bodyOf, toOwner } from "./harness";
import { eventually } from "../fixtures/wait";

test("task acceptance: capture → editable confirmation → reschedule removes old alarm → reminder → result at source",async(t)=>{
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
  const moved=s.clock.t+20_000;
  const editBody={card,component:"f.save",data:{title:"交报税材料",remind:new Date(moved).toISOString(),editing:true}};
  const edit=await owner.call("service:cards","act",editBody);
  assert.ok(edit.ok,JSON.stringify(edit));assert.equal(dataOf(edit).state,"ok",JSON.stringify(edit));
  assert.equal(dataOf(await owner.call("service:tasks","get",{id:task.id})).task.remind_at,moved);
  // The same confirmation can be pressed twice without creating a second task.
  assert.equal(dataOf(await owner.call("service:cards","act",editBody)).state,"ok");
  assert.equal(dataOf(await owner.call("service:tasks","list")).tasks.length,1);
  assert.ok((await owner.call("service:clock","set",{at:s.clock.t+10_000,to:"person:owner",word:"say",body:{text:"old-time fence"},label:"old-time fence"})).ok);
  s.advance(10_001);s.hostEvent({event:"wake.fired",at:s.clock.t});
  await owner.seen(m=>toOwner("say")(m)&&bodyOf(m).text==="old-time fence","the real clock checked the old reminder slot");
  assert.equal(owner.messages.filter(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".remind.")).length,0);
  s.advance(10_000);s.hostEvent({event:"wake.fired",at:s.clock.t});
  const reminder=await owner.seen(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".remind."),"rescheduled reminder card");
  const done=await owner.call("service:cards","act",{card:bodyOf(reminder).id,component:"done"});
  assert.ok(done.ok,JSON.stringify(done));assert.equal(dataOf(done).state,"ok",JSON.stringify(done));
  assert.equal(dataOf(await owner.call("service:tasks","get",{id:task.id})).task.status,"done");
  const report=await owner.seen(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".report."),"completion report at source");
  assert.equal(report.reply_to,task.source.message);
  await owner.call("service:tasks","done",{id:task.id});
  assert.equal(owner.messages.filter(m=>toOwner("show","service:tasks")(m)&&String(bodyOf(m).id).includes(".report.")).length,1);
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


test("task acceptance: server saved successfully, channel disconnects, retry confirms the same task and completion",async(t)=>{
  const s=await startScenario(t,{fakeNow:true,runtimes:["scripted"]});
  const owner=await s.human();
  const source=accepted(await owner.say("记下交报税材料"));
  const body={title:"交报税材料",source:{message:source.message.id},client_id:"phone-materials"};
  const sent=await owner.call("service:tasks","add",body);assert.ok(sent.ok);
  const id=dataOf(sent).task.id;
  owner.disconnect(); // The application discards the successful receipt before it can clear its local pending record.
  const returned=await s.human({name:"returned task screen"});
  const retried=dataOf(await returned.call("service:tasks","add",body));
  assert.equal(retried.task.id,id);assert.equal(retried.created,false);
  assert.equal(dataOf(await returned.call("service:tasks","list")).tasks.length,1);
  assert.ok((await returned.call("service:tasks","done",{id})).ok);
  returned.disconnect();
  const again=await s.human({name:"returned completion screen"});
  assert.ok((await again.call("service:tasks","done",{id})).ok);
  const changes=dataOf(await again.call("service:tasks","get",{id})).changes;
  assert.equal(changes.filter((c:any)=>c.change==="done").length,1);
  const history=dataOf(await again.call("service:history","window",{limit:100}));
  assert.equal(history.items.filter((i:any)=>i.card?.id?.includes(`task.${id}.report.`)).length,1);
});

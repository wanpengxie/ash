import test from 'node:test';
import assert from 'node:assert/strict';
import {startScenario,extensionCapability,dataOf} from './harness';

test('Coworker discovery and saved history travel through authenticated human and device ash-link channels',async t=>{
 const s=await startScenario(t);
 const pc=await s.hand({kind:'computer',capabilities:['collaboration.endpoint.describe','collaboration.work.list','collaboration.work.read'].map(name=>extensionCapability(name,{callers:['owner']}))});
 const id=pc.member.slice(7),revision='a'.repeat(64);
 pc.on('collaboration.endpoint.describe',()=>({ok:true,content:[],data:{collaboration:{version:1,node_id:id,endpoint_id:id,adapter:'desktop/codex',authorization_state:'ready',authorization_generation:1,authorization_revision:revision,runtime_availability:'unknown',scope_kind:'exact_cwd',source:'codex.saved_history',runtime_state:'unknown',control:'unsupported'}}}));
 pc.on('collaboration.work.list',call=>{assert.equal(call.caller.member,'person:owner');return {ok:true,content:[],data:{items:[],next_cursor:null,observed_at:new Date().toISOString(),completeness:'source_page',source:'codex.saved_history',runtime_state:'unknown'}};});
 const owner=await s.human();
 const discovery=await owner.call('service:collaboration','collaboration.endpoints',{});
 assert.ok(discovery.ok,JSON.stringify(discovery));const discovered=dataOf(discovery);assert.equal(discovered.targets[0].device_id,pc.member);
 const read=await owner.call('service:collaboration','collaboration.read',{version:1,device_id:pc.member,endpoint_id:id,authorization_generation:1,authorization_revision:revision,action:'list_work'});
 assert.ok(read.ok,JSON.stringify(read));assert.deepEqual(dataOf(read).page.items,[]);assert.equal(dataOf(read).auth_scope,discovered.auth_scope);
});

test('Coworker control and create use the same routed device call and preserve their separate grants',async t=>{
 const s=await startScenario(t),operations=['state','apply','query','reconcile'],createOps=['projects','apply','query','reconcile'];
 const names=['collaboration.endpoint.describe',...operations.map(x=>'collaboration.control.'+x),...createOps.map(x=>'collaboration.create.'+x)];
 const pc=await s.hand({kind:'computer',capabilities:names.map(name=>extensionCapability(name,{callers:['owner'],effect:name.endsWith('.apply')?'act':'read',risk:name.endsWith('.apply')?'outward':'none'}))});
 const id=pc.member.slice(7),revision='a'.repeat(64),work={node_id:id,endpoint_id:id,kind:'conversation',native_id:'native-work'};
 const limitations={atomic_idle_start:false,cancel:false,queue:false,runtime_state:'unknown',subscription_state:'unknown'};
 pc.on('collaboration.endpoint.describe',()=>({ok:true,content:[],data:{collaboration_control:{version:1,endpoint_id:id,grant_state:'ready',authorization_revision:revision,actions:['send_input'],limitations},collaboration_create:{version:1,endpoint_id:id,grant_state:'ready',authorization_revision:revision,actions:createOps,scope:{kind:'exact_cwd',cwd:'/work'},limitations:{native_readiness:'unknown',cancel:false,automatic_replay:false,execution_completion:'unknown'}}}}));
 pc.on('collaboration.control.state',call=>({ok:true,content:[],data:{target:{endpoint_id:id,work},authorization_revision:revision,connector_epoch:'epoch',native_interface_version:'fixture',snapshot:{state:'unknown',revision:0,work,connector_epoch:'epoch',source:'codex.live',observed_at:null,identity_provenance:'none'},allowed_actions:['send_input'],limitations}}));
 pc.on('collaboration.control.query',()=>({ok:true,content:[],data:{fact:null}}));
 pc.on('collaboration.create.projects',()=>({ok:true,content:[],data:{target:{node_id:id,endpoint_id:id,cwd:'/work'},authorization_revision:revision,connector_epoch:'epoch',native_interface_version:'fixture',projects:[{project_id:'project',cwd:'/work'}],complete:true}}));
 const owner=await s.human(),base={version:1,device_id:pc.member,endpoint_id:id,authorization_revision:revision};
 const discovery=await owner.call('service:collaboration','collaboration.control.endpoints');assert.ok(discovery.ok,JSON.stringify(discovery));assert.equal(dataOf(discovery).control_targets.length,1);
 const state=await owner.call('service:collaboration','collaboration.control.state',{...base,work,action:'send_input'});assert.ok(state.ok,JSON.stringify(state));assert.equal(dataOf(state).snapshot.state,'unknown');
 const query=await owner.call('service:collaboration','collaboration.control.query',{...base,work,action:'send_input',operation_id:'op'});assert.ok(query.ok,JSON.stringify(query));assert.equal(dataOf(query).fact,null);
 const projects=await owner.call('service:collaboration','collaboration.create.projects',{...base,node_id:id,cwd:'/work'});assert.ok(projects.ok,JSON.stringify(projects));assert.equal(dataOf(projects).projects[0].project_id,'project');
 const stale=await owner.call('service:collaboration','collaboration.create.projects',{...base,node_id:id,cwd:'/different'});assert.equal(stale.ok,false);
});

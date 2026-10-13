import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWork } from '../js/desktop-work.js';
import { DesktopWorkStore, targetKey, workKey } from '../js/desktop-work-store.js';
const target = { device_id:'device:pc', node_id:'pc', endpoint_id:'pc', name:'电脑', authorization_generation:1, authorization_revision:'a'.repeat(64), authorization_state:'ready', source:'codex.saved_history',runtime_state:'unknown',control:'unsupported',actions:['list_work','read_work'] };
const work = { node_id:'pc',endpoint_id:'pc',kind:'conversation',native_id:'same' };
const page = (items, cursor=null) => ({items,next_cursor:cursor,observed_at:'2026-10-09T01:00:00Z',source:'codex.saved_history',runtime_state:'unknown',completeness:'source_page'});
const turn = (id,text='hello') => ({turn_id:id,history_status:null,status_source:'codex.saved_history',messages:[{work,turn_id:id,source_message_id:id,role:'assistant',text}]});
const storage = () => { const values = new Map(); return { getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k) }; };
test('auth identity, core origin and permission revision isolate caches', () => {
  const disk = storage(), s = new DesktopWorkStore({storage:disk,endpoint:'coreA'}); s.bind('ownerA'); s.reconcile([target]); s.put(target,work,page([turn('a')]));
  const restored = new DesktopWorkStore({storage:disk,endpoint:'coreA'}); restored.bind('ownerA'); assert.equal(restored.get(target,work).page.items.length,1);
  assert.equal(s.get({...target,authorization_revision:'b'.repeat(64)},work),null);
  s.reconcile([{...target,authorization_generation:2}]); assert.equal(s.get(target,work),null);
  s.bind('ownerB'); assert.equal(s.get(target,work),null);
  assert.notEqual(workKey(work),workKey({...work,node_id:'other'})); assert.notEqual(targetKey(target),targetKey({...target,endpoint_id:'other'}));
  const other = new DesktopWorkStore({storage:disk,endpoint:'coreB'}); other.bind('ownerA'); assert.equal(other.get(target,work),null);
});
test('upsert retains source missing rows and keeps old cursor separate from refresh cursor', () => {
  const s = new DesktopWorkStore({storage:storage()}); s.bind('a'); s.put(target,work,page([turn('b')],'old')); s.put(target,work,page([turn('a')],null),{older:true});
  const result=s.put(target,work,page([turn('b','updated'),turn('c')],'new'));
  assert.deepEqual(result.page.items.map(t=>t.turn_id),['a','b','c']); assert.equal(result.page.items[1].messages[0].text,'updated'); assert.equal(result.latest_cursor,'new'); assert.equal(result.older_cursor,null);
  s.put(target,work,page([turn('c')])); assert.equal(s.get(target,work).page.items.length,3);
  assert.throws(()=>s.put(target,work,page([],''))); assert.throws(()=>s.put(target,work,page([{...turn('x'),messages:[{...turn('x').messages[0],work:{...work,node_id:'evil'}}]}])));
});
test('storage errors degrade safely; byte, message, count and expiry bounds are real', () => {
  let clock=0; const s=new DesktopWorkStore({storage:{getItem(){throw Error('blocked')},setItem(){throw Error('full')},removeItem(){}},now:()=>clock,limits:{ttl:10,works:2,messages:2,bytes:2000}}); s.bind('a');
  s.put(target,work,page([turn('a'),turn('b'),turn('c')])); assert.equal(s.get(target,work).page.items.length,2); assert.equal(s.get(target,work).incomplete,true); assert.equal(s.persistent,false);
  for(let i=0;i<8;i++) { const w={...work,native_id:String(i)}, t=turn('a'); t.messages[0].work=w; s.put(target,w,page([t])); } assert.ok(Object.keys(s.entries).length<=3); assert.ok(new TextEncoder().encode(JSON.stringify(s.entries)).length<=2000);
  clock=11; s.prune(); assert.equal(Object.keys(s.entries).length,0);
});
test('material payloads and locators never enter cache', () => {
  const s = new DesktopWorkStore({storage:storage()}); s.bind('a'); const t=turn('a'); t.messages[0].material_refs=[{kind:'image',source_part_index:0,availability:'reference_only',url:'https://secret',path:'/secret'}];
  const result=s.put(target,work,page([t])); assert.deepEqual(result.page.items[0].messages[0].material_refs,[{kind:'image',source_part_index:0,availability:'reference_only'}]);
});

test('repeating older cursor stops pagination instead of looping', () => {
  const s = new DesktopWorkStore({storage:storage()}); s.bind('a'); s.put(target,work,page([turn('b')],'repeat'));
  const result=s.put(target,work,page([turn('a')],'repeat'),{older:true}); assert.equal(result.older_cursor,null); assert.equal(result.incomplete,true);
});

test('disjoint latest pages expose a gap without losing the old history cursor', () => {
 const s=new DesktopWorkStore({storage:storage()});s.bind('a');s.put(target,work,page([turn('a')],null));
 let result=s.put(target,work,page([turn('z')],'gap'));assert.equal(result.gap_cursor,'gap');assert.equal(result.older_cursor,null);
 result=s.put(target,work,page([turn('y')],'gap2'),{older:true});assert.equal(result.gap_cursor,'gap2');assert.deepEqual(result.page.items.map(t=>t.turn_id),['a','y','z']);
 result=s.put(target,work,page([turn('x'),turn('y')],'gap3'),{older:true});assert.equal(result.gap_cursor,'gap3');assert.deepEqual(result.page.items.map(t=>t.turn_id),['a','x','y','z']);
 result=s.put(target,work,page([turn('a')],null),{older:true});assert.equal(result.gap_cursor,null);assert.equal(result.older_cursor,null);
});

test('refresh rebinds after screen identity reset and send errors preserve read polling', async () => {
 const disk=storage(), store=new DesktopWorkStore({storage:disk});store.bind('A');store.reconcile([target]);
 store.put(target,null,page([{work,title:'A secret',cwd:'/a',updated_at:1,runtime_state:'unknown'}]));
 const net={currentScope:'B',connectionId:'B-connectionId',collaborationEndpoints:async()=>({auth_scope:'B',targets:[target]}),collaborationRead:async()=>({auth_scope:'B',target,page:page([{work,title:'B title',cwd:'/b',updated_at:2,runtime_state:'unknown'}])})};
 const view=new DesktopWork({ownerDocument:{hidden:false,addEventListener(){}}},net,{store,control:{network(){},reset(){},stop(){}}});view.render=()=>{};view.opened=true;view.target=target;
 const epoch=view.epoch;view.network('send-error');assert.equal(view.epoch,epoch);
 await view.refresh();assert.equal(store.scope,'B');assert.equal(store.get(target).page.items[0].title,'B title');assert.equal(disk.getItem('ash.desktop.saved-history.v1').includes('A secret'),false);
 view.targets=[target];view.reset();assert.deepEqual(view.targets,[]);view.cancel();
});

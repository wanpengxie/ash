import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesktopSharedDrafts,joinSharedText} from '../js/desktop-shared-drafts.js';
test('shares append real blank lines, deduplicate IDs, and stay at their scoped destination',()=>{
 const d=new DesktopSharedDrafts();d.bind('one');d.enabled=true;
 assert.equal(joinSharedText('原文','https://example.com'),'原文\n\nhttps://example.com');
 assert.equal(d.remember('control','old','原文'),true);assert.equal(d.stage({id:'a',text:'https://example.com'}),true);
 assert.equal(d.stage({id:'a',text:'https://example.com'}),true);
 assert.equal(d.take('control','other',''),'https://example.com');assert.equal(d.take('control','old',''),'原文');
 d.forget('control','other');d.stage({id:'b',text:'https://example.com'});assert.equal(d.take('create','project','要求'),'要求\n\nhttps://example.com');
 d.remember('control','old','private');d.stage({id:'c',text:'private link'});d.bind('two');assert.equal(d.pending,'');assert.equal(d.saved.size,0);
});
test('two bounded unsent destinations never overwrite a third and submitted drafts are forgotten',()=>{
 const d=new DesktopSharedDrafts();d.bind('one');d.enabled=true;
 assert.equal(d.remember('control','old','original'),true);assert.equal(d.remember('create','project','edited share'),true);
 assert.equal(d.remember('control','third','third draft'),false);assert.equal(d.saved.size,2);
 assert.equal(d.take('control','old',''),'original');d.remember('control','old','original');d.forget('control','old');assert.equal(d.take('control','old',''),null);
});
test('bounded duplicate memory accepts the sixty fifth distinct share',()=>{
 const d=new DesktopSharedDrafts();d.bind('one');for(let i=0;i<65;i++){assert.equal(d.stage({id:String(i),text:'https://example.com'}),true);d.take('control','work','');}assert.equal(d.seen.size,64);
});
test('combined draft overflow preserves pending text and reports a recoverable failure',()=>{
 const d=new DesktopSharedDrafts();d.bind('one');d.stage({id:'one',text:'a'.repeat(32768)});d.stage({id:'two',text:'b'.repeat(32766)});
 const pending=d.pending;assert.equal(d.take('control','work','c'.repeat(128*1024)),null);assert.equal(d.takeError,'too_large');assert.equal(d.pending,pending);
 assert.equal(d.take('control','work',''),pending);assert.equal(d.takeError,null);
});

const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
test('ordinary input and consumed share survive new instances until explicit submission',()=>{
 const storage=memory(),options={storage,endpoint:'one',requireStorage:true};let d=new DesktopSharedDrafts(options);d.bind('scope');
 assert.equal(d.remember('control','revision-one/thread','普通输入'),true);assert.equal(d.stage({id:'share',text:'链接'}),true);
 d=new DesktopSharedDrafts(options);d.bind('scope');assert.equal(d.take('control','revision-one/thread',''),'普通输入\n\n链接');
 d=new DesktopSharedDrafts(options);d.bind('scope');assert.equal(d.stage({id:'share',text:'链接'}),true);assert.equal(d.pending,'');assert.equal(d.take('control','revision-one/thread',''),'普通输入\n\n链接');
 assert.equal(d.forget('control','revision-one/thread'),true);d=new DesktopSharedDrafts(options);d.bind('scope');assert.equal(d.take('control','revision-one/thread',''),null);
});
test('endpoint scope grant and project keys isolate restoration and expiry is bounded',()=>{
 const storage=memory();let now=1000;const options={storage,endpoint:'one',now:()=>now};let d=new DesktopSharedDrafts(options);d.bind('scope-one');d.remember('control','grant-one/thread','private');d.remember('create','project-one/cwd','new private');
 d=new DesktopSharedDrafts({...options,endpoint:'two'});d.bind('scope-one');assert.equal(d.take('control','grant-one/thread',''),null);
 d=new DesktopSharedDrafts(options);d.bind('scope-two');assert.equal(d.take('control','grant-one/thread',''),null);d.clear();d.bind('scope-one');assert.equal(d.take('control','grant-two/thread',''),null);assert.equal(d.take('create','project-two/cwd',''),null);assert.equal(d.take('control','grant-one/thread',''),'private');
 now+=8*86400000;d=new DesktopSharedDrafts(options);d.bind('scope-one');assert.equal(d.take('control','grant-one/thread',''),null);
});
test('write failure rejects ACK and consume without losing the last saved draft',()=>{
 const storage=memory(),options={storage,endpoint:'one',requireStorage:true};const d=new DesktopSharedDrafts(options);d.bind('scope');d.remember('control','thread','private');d.stage({id:'first',text:'first'});
 const set=storage.setItem;storage.setItem=()=>{throw Error('full');};assert.equal(d.stage({id:'second',text:'second'}),false);assert.equal(d.seen.has('second'),false);assert.equal(d.take('control','thread',''),null);assert.equal(d.pending,'first');assert.equal(d.saved.get(d.slot('control','thread')),'private');assert.equal(d.forget('control','thread'),false);
 storage.setItem=set;assert.equal(d.take('control','thread',''),'private\n\nfirst');
 const reopened=new DesktopSharedDrafts(options);reopened.bind('scope');assert.equal(reopened.take('control','thread',''),'private\n\nfirst');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MaterialInputLocators,type MaterialInputLocator} from '../src/collaboration/material-input-locators';
// This fixture tests physical metadata integrity; it issues no actor, control, custody or canonical authority.
const locator=(index=0):MaterialInputLocator=>({selection:{purpose:'input_asset',binding_id:'binding-'+index,request_id:'request-'+index,asset_id:'asset',asset_version:1,sha256:'a'.repeat(64),byte_length:0,media_type:'text/plain'},requestHash:'b'.repeat(64),custodyId:'c'.repeat(64),peerId:'paired-source',expires:10000});
test('protected locators reopen original metadata, allow exact verified binding refresh, and isolate owners',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ash-input-locators-'))),file=join(root,'locators.sqlite');let db:MaterialInputLocators|undefined;try{
 db=new MaterialInputLocators(file,()=>undefined,()=>1000);db.record(locator(),()=>undefined);db.close();db=new MaterialInputLocators(file,()=>undefined,()=>1000);
 assert.deepEqual(db.get('paired-source','request-0','asset',1),locator());assert.equal(statSync(file).mode&0o777,0o600);assert.equal(db.get('different-source','request-0','asset',1),null);
 const next={...locator(),selection:{...locator().selection,binding_id:'current-new-binding'}};db.record(next,()=>undefined);assert.equal(db.get('paired-source','request-0','asset',1)!.selection.binding_id,'current-new-binding');
 assert.throws(()=>db!.record({...next,custodyId:'d'.repeat(64)},()=>undefined),/conflict/);assert.throws(()=>db!.record({...next,selection:{...next.selection,media_type:'image/png'}},()=>undefined),/conflict/);
 assert.throws(()=>db!.record({...next,selection:{...next.selection,binding_id:'never-committed'}},()=>{throw Error('original current revoked');}));assert.equal(db.get('paired-source','request-0','asset',1)!.selection.binding_id,'current-new-binding');
 assert.equal(readFileSync(file).includes(Buffer.from('body-secret')),false);
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
test('128 locator capacity is durable; only expired metadata permits a new locator and never revives old expiry',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ash-input-locators-'))),file=join(root,'locators.sqlite');let now=1000,db:MaterialInputLocators|undefined;try{
 db=new MaterialInputLocators(file,()=>undefined,()=>now);for(let i=0;i<128;i++)db.record(locator(i),()=>undefined);assert.throws(()=>db!.record(locator(128),()=>undefined),/too_large/);db.close();db=new MaterialInputLocators(file,()=>undefined,()=>now);assert.throws(()=>db!.record(locator(128),()=>undefined),/too_large/);
 now=11000;assert.equal(db.get('paired-source','request-0','asset',1),null);assert.throws(()=>db!.record(locator(),()=>undefined),/invalid/);db.record({...locator(128),expires:20000},()=>undefined);assert.equal(db.get('paired-source','request-0','asset',1),null);assert.ok(db.get('paired-source','request-128','asset',1));
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});

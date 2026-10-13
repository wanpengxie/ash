import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {MaterialProtocolError} from './material-types';
import {freezeInputMetadata,parseInputProviderSelection,type InputProviderSelection} from './material-provider-protocol';
export interface MaterialInputLocator {
 readonly selection:InputProviderSelection;
 readonly requestHash:string;
 readonly custodyId:string;
 readonly peerId:string;
 readonly expires:number;
}
const fail=(code:'offline'|'invalid'|'conflict'|'too_large'='offline'):never=>{throw new MaterialProtocolError(code);};
/** Protected metadata only. Every caller must reacquire signed canonical, pair, receive and control authority. */
export class MaterialInputLocators {
 private readonly db:DatabaseSync;
 private readonly fd:number;
 private readonly identity:string;
 private readonly rootIdentity:string;
 private closed=false;
 constructor(private readonly file:string,private readonly physicalCurrent:()=>undefined,private readonly clock:()=>number=Date.now){
  const parent=lstatSync(dirname(file));
  if(!parent.isDirectory()||parent.isSymbolicLink()||realpathSync(dirname(file))!==dirname(file)||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)fail();
  this.rootIdentity=`${parent.dev}:${parent.ino}`;
  this.fd=openSync(file,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  let db:DatabaseSync|undefined;
  try{
   const s=fstatSync(this.fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.uid!==process.getuid?.())fail();
   this.identity=`${s.dev}:${s.ino}`;this.current();this.db=db=new DatabaseSync(file);this.current();
   db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;BEGIN IMMEDIATE');
   try{this.current();db.exec('CREATE TABLE IF NOT EXISTS material_input_locators(peer TEXT NOT NULL,request TEXT NOT NULL,asset TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(peer,request,asset,version));CREATE TABLE IF NOT EXISTS material_input_locator_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);INSERT OR IGNORE INTO material_input_locator_revision VALUES(1,0);');this.capacity();const revision=db.prepare('SELECT revision FROM material_input_locator_revision WHERE id=1').get() as {revision:number};if(!Number.isSafeInteger(revision.revision)||revision.revision<0)fail();this.current();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){db?.close();closeSync(this.fd);throw error;}
 }
 private current():undefined{
  if(this.closed||this.physicalCurrent()!==undefined)fail();
  const root=lstatSync(dirname(this.file)),s=lstatSync(this.file),fd=fstatSync(this.fd);
  if(!root.isDirectory()||root.isSymbolicLink()||`${root.dev}:${root.ino}`!==this.rootIdentity||root.uid!==process.getuid?.()||(root.mode&0o077)!==0||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)!==0||s.uid!==process.getuid?.()||`${s.dev}:${s.ino}`!==this.identity||`${fd.dev}:${fd.ino}`!==this.identity)fail();
  return undefined;
 }
 private parse(value:unknown):MaterialInputLocator{
  const v=value as MaterialInputLocator;
  if(!v||Object.keys(v).sort().join(',')!=='custodyId,expires,peerId,requestHash,selection'||typeof v.peerId!=='string'||!v.peerId||Buffer.byteLength(v.peerId)>256||! /^[a-f0-9]{64}$/.test(v.requestHash)||! /^[a-f0-9]{64}$/.test(v.custodyId)||!Number.isSafeInteger(v.expires))fail('invalid');
  return freezeInputMetadata({selection:parseInputProviderSelection(v.selection),requestHash:v.requestHash,custodyId:v.custodyId,peerId:v.peerId,expires:v.expires});
 }
 get(peer:string,request:string,asset:string,version:number):MaterialInputLocator|null{
  this.current();const row=this.db.prepare('SELECT value FROM material_input_locators WHERE peer=? AND request=? AND asset=? AND version=?').get(peer,request,asset,version) as {value:string}|undefined;
  if(!row)return null;const value=this.parse(JSON.parse(row.value));if(value.peerId!==peer||value.selection.request_id!==request||value.selection.asset_id!==asset||value.selection.asset_version!==version)fail('conflict');if(value.expires<=this.clock())return null;this.current();return value;
 }
 /** Only a newly verified projection may call this; the row itself never proves authorization. */
 record(input:MaterialInputLocator,current:()=>undefined):void{
  input=this.parse(input);const fence=()=>{this.current();if(current()!==undefined)fail();if(input.expires<=this.clock())fail('invalid');};fence();
  const s=input.selection,raw=JSON.stringify(input);this.db.exec('BEGIN IMMEDIATE');
  try{
   fence();const previous=this.get(input.peerId,s.request_id,s.asset_id,s.asset_version);
   if(previous&&(previous.requestHash!==input.requestHash||previous.custodyId!==input.custodyId||JSON.stringify({...previous.selection,binding_id:s.binding_id})!==JSON.stringify(s)||previous.expires!==input.expires))fail('conflict');
   this.db.prepare('DELETE FROM material_input_locators WHERE json_extract(value,\'$.expires\')<=?').run(this.clock());
   this.db.prepare('INSERT INTO material_input_locators(peer,request,asset,version,value) VALUES(?,?,?,?,?) ON CONFLICT(peer,request,asset,version) DO UPDATE SET value=excluded.value').run(input.peerId,s.request_id,s.asset_id,s.asset_version,raw);
   this.capacity();
   const rev=this.db.prepare('SELECT revision FROM material_input_locator_revision WHERE id=1').get() as {revision:number};if(!Number.isSafeInteger(rev.revision)||rev.revision>=Number.MAX_SAFE_INTEGER)fail('too_large');
   this.db.prepare('UPDATE material_input_locator_revision SET revision=revision+1 WHERE id=1').run();fence();this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private capacity():void{const capacity=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM material_input_locators').get() as {n:number;bytes:number};if(capacity.n>128||capacity.bytes>131072)fail('too_large');}
 close():void{if(this.closed)return;this.closed=true;try{this.db.close();}finally{closeSync(this.fd);}}
}

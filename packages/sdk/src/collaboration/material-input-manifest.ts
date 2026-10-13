import {createHash} from 'node:crypto';
import {MATERIAL_LIMITS,MaterialProtocolError} from './material-types';
export const MATERIAL_INPUT_PROFILE='staged-image-utf8/v1' as const;
export interface MaterialInputAsset {readonly asset_id:string;readonly asset_version:number;readonly sha256:string;readonly byte_length:number;readonly media_type:'image/png'|'image/jpeg'|'text/plain';}
export interface MaterialInputSelection {readonly version:1;readonly profile:typeof MATERIAL_INPUT_PROFILE;readonly request_id:string;readonly assets:readonly MaterialInputAsset[];}
function fail(code:ConstructorParameters<typeof MaterialProtocolError>[0]='invalid'):never{throw new MaterialProtocolError(code);}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail();return value as Record<string,unknown>;}
function id(value:unknown):string{if(typeof value!=='string'||!value||Buffer.byteLength(value)>256||/[\x00-\x1f]/.test(value))fail();return value as string;}
export function parseMaterialInputSelection(value:unknown):MaterialInputSelection {
 const v=record(value,['version','profile','request_id','assets']);if(v.version!==1||v.profile!==MATERIAL_INPUT_PROFILE||!Array.isArray(v.assets)||v.assets.length<1||v.assets.length>4)fail();const seen=new Set<string>();let bytes=0;
 const assets=(v.assets as unknown[]).map(raw=>{const a=record(raw,['asset_id','asset_version','sha256','byte_length','media_type']),asset_id=id(a.asset_id);if(!Number.isSafeInteger(a.asset_version)||Number(a.asset_version)<1||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.byte_length)||Number(a.byte_length)<0)fail();if(Number(a.byte_length)>MATERIAL_LIMITS.file_bytes)fail('too_large');if(!['image/png','image/jpeg','text/plain'].includes(String(a.media_type)))fail('unsupported');const key=JSON.stringify([asset_id,a.asset_version]);if(seen.has(key))fail();seen.add(key);bytes+=Number(a.byte_length);return Object.freeze({asset_id,asset_version:Number(a.asset_version),sha256:a.sha256 as string,byte_length:Number(a.byte_length),media_type:a.media_type as MaterialInputAsset['media_type']});});if(bytes>MATERIAL_LIMITS.request_bytes)fail('too_large');return Object.freeze({version:1,profile:MATERIAL_INPUT_PROFILE,request_id:id(v.request_id),assets:Object.freeze(assets)});
}
/** Stable identity excludes local paths, display names, and native serialization. */
export function materialInputManifestHash(value:unknown):string {const m=parseMaterialInputSelection(value);return createHash('sha256').update(JSON.stringify(['ash.material.input.manifest/v1',m.version,m.profile,m.request_id,m.assets.map(a=>[a.asset_id,a.asset_version,a.sha256,a.byte_length,a.media_type])])).digest('hex');}
const dimensions=(width:number,height:number)=>{if(!width||!height||width>16384||height>16384||width*height>40_000_000)fail('too_large');return Object.freeze({width,height});};
/** Bounded format/header validation; native decode remains a separate consumption fact. */
export function verifyMaterialInputBytes(asset:MaterialInputAsset,input:Uint8Array):{width:number;height:number}|{text:string} {
 const a=parseMaterialInputSelection({version:1,profile:MATERIAL_INPUT_PROFILE,request_id:'validation',assets:[asset]}).assets[0]!,bytes=Buffer.from(input);
 if(bytes.length!==a.byte_length||createHash('sha256').update(bytes).digest('hex')!==a.sha256)fail('hash_mismatch');
 if(a.media_type==='text/plain'){let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return fail();}if(text.includes('\0'))fail();if(bytes.length>65536)fail('too_large');return {text};}
 if(a.media_type==='image/png'){
  if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')fail();
  const size=dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));let offset=8,first=true,idat=false,ended=false;
  while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset);if(length>bytes.length-offset-12)fail();const kind=bytes.toString('ascii',offset+4,offset+8);if(first&&kind!=='IHDR'||!first&&kind==='IHDR')fail();first=false;let crc=0xffffffff;for(const byte of bytes.subarray(offset+4,offset+8+length)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}if(((crc^0xffffffff)>>>0)!==bytes.readUInt32BE(offset+8+length))fail();if(kind==='IDAT')idat=true;offset+=length+12;if(kind==='IEND'){if(length!==0||offset!==bytes.length)fail();ended=true;break;}}
  if(!idat||!ended)fail();const depth=bytes[24]!,color=bytes[25]!,allowed:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};if(!allowed[color]?.includes(depth)||bytes[26]!==0||bytes[27]!==0||bytes[28]!>1)fail();return size;
 }
 if(bytes.length<8||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)fail();let offset=2,size:{width:number;height:number}|undefined;
 while(offset+4<=Math.min(bytes.length,65536)){if(bytes[offset++]!==255)fail();while(bytes[offset]===255)offset++;const marker=bytes[offset++]!;if(marker===218){if(!size)fail();return size;}if(marker===216||marker===217||marker===0||marker>=208&&marker<=215)fail();const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length||offset+length>65536)fail();if([192,193,194].includes(marker)){if(length<8||size)fail();size=dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));}offset+=length;}
 return fail();
}
export function materialInputText(text:string,files:readonly {asset:MaterialInputAsset;bytes:Uint8Array}[]):string {
 if(typeof text!=='string'||text.includes('\0'))fail();let result=text;for(const file of files){if(file.asset.media_type!=='text/plain')fail();const verified=verifyMaterialInputBytes(file.asset,file.bytes);if(!('text'in verified))fail();result+='\n\n[Material '+JSON.stringify([file.asset.asset_id,file.asset.asset_version,file.asset.sha256])+']\n'+verified.text+'\n[/Material]';}if(Buffer.byteLength(result)>65536)fail('too_large');return result;
}

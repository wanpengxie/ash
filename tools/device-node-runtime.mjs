// Pinned official runtime. Extracts one literal regular tar member into an exclusive file.
import {createHash} from 'node:crypto';
import {writeFileSync,chmodSync} from 'node:fs';
import {createGunzip} from 'node:zlib';
export const DEVICE_NODE_VERSION='22.22.1';
const MAX_ARCHIVE=128*1024*1024,MAX_TAR=512*1024*1024,MAX_NODE=128*1024*1024;
const fail=message=>{throw Error('Device runtime: '+message);};
export function runtimeAsset(platform,arch){if(platform!=='darwin'||!['arm64','x64'].includes(arch))fail('unsupported target');return `node-v${DEVICE_NODE_VERSION}-${platform}-${arch}.tar.gz`;}
export function checksumFor(text,asset){if(typeof text!=='string'||Buffer.byteLength(text)>128*1024)fail('invalid checksum manifest');const entries=text.split(/\r?\n/).filter(line=>line.endsWith('  '+asset));if(entries.length!==1||!new RegExp('^[a-f0-9]{64}  '+asset.replaceAll('.','\\.')+'$').test(entries[0]))fail('missing or ambiguous checksum');return entries[0].slice(0,64);}
export function assertRuntimeCpu(bytes,arch){if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==(arch==='arm64'?0x0100000c:arch==='x64'?0x01000007:-1))fail('Mach-O target mismatch');}
function text(bytes){const end=bytes.indexOf(0);return bytes.subarray(0,end<0?bytes.length:end).toString('utf8');}
function octal(bytes){const value=text(bytes).trim();if(!/^[0-7]+$/.test(value))fail('unsupported tar number');const number=parseInt(value,8);if(!Number.isSafeInteger(number))fail('tar size');return number;}
/** No archive pathname is ever used as a filesystem path, including links or extended names. */
export function extractRuntimeTar(tar,asset,arch){if(!Buffer.isBuffer(tar)||tar.length>MAX_TAR||tar.length%512)fail('invalid tar');const member=asset.slice(0,-7)+'/bin/node';let selected,offset=0,ended=false,extended=false,globalExtended=false;
 while(offset+512<=tar.length){const header=tar.subarray(offset,offset+512);offset+=512;if(header.every(byte=>byte===0)){ended=true;if(tar.subarray(offset).some(byte=>byte!==0))fail('trailing tar data');break;}
  const expected=octal(header.subarray(148,156));let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:header[i];if(actual!==expected)fail('tar header checksum');
  const size=octal(header.subarray(124,136));if(size>MAX_TAR||offset+size>tar.length)fail('truncated tar');const name=text(header.subarray(0,100)),prefix=text(header.subarray(345,500)),path=prefix?prefix+'/'+name:name,type=header[156];
  if(path===member){if(selected||extended||globalExtended||![0,48].includes(type)||size<32||size>MAX_NODE)fail('runtime must be one literal regular member');selected=Buffer.from(tar.subarray(offset,offset+size));}
  if(type===103)globalExtended=true;extended=[120,76,75].includes(type);offset+=Math.ceil(size/512)*512;
 }
 if(!ended||!selected)fail('runtime member missing');assertRuntimeCpu(selected,arch);return selected;
}
async function boundedBody(url,limit,fetchImpl,timeoutMs){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let reader;try{const response=await fetchImpl(url,{redirect:'error',signal:controller.signal});if(!response.ok||response.redirected||(response.url&&response.url!==url)||!response.body)fail('download failed');const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))fail('download bound');reader=response.body.getReader();const chunks=[];let total=0;while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>limit)fail('download bound');chunks.push(Buffer.from(part.value));}return Buffer.concat(chunks,total);}catch{fail(controller.signal.aborted?'download deadline':'download failed');}finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});}}
async function inflate(bytes,timeoutMs){return new Promise((resolve,reject)=>{const stream=createGunzip(),chunks=[];let total=0,settled=false;const timer=setTimeout(()=>stream.destroy(Error('inflate deadline')),timeoutMs);const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);stream.destroy();error?reject(Error('Device runtime: archive invalid or deadline')):resolve(result);};stream.on('data',chunk=>{total+=chunk.length;if(total>MAX_TAR){stream.destroy(Error('inflate bound'));return;}chunks.push(chunk);});stream.once('error',error=>finish(error));stream.once('end',()=>finish(undefined,Buffer.concat(chunks,total)));stream.end(bytes);});}
export async function acquireDeviceNodeRuntime(output,{platform=process.platform,arch=process.arch,fetchImpl=fetch,timeoutMs=20000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('invalid deadline');const asset=runtimeAsset(platform,arch),base=`https://nodejs.org/dist/v${DEVICE_NODE_VERSION}`;
 const manifest=(await boundedBody(base+'/SHASUMS256.txt',128*1024,fetchImpl,timeoutMs)).toString('utf8'),expected=checksumFor(manifest,asset),archive=await boundedBody(base+'/'+asset,MAX_ARCHIVE,fetchImpl,timeoutMs);
 if(createHash('sha256').update(archive).digest('hex')!==expected)fail('archive checksum mismatch');const node=extractRuntimeTar(await inflate(archive,timeoutMs),asset,arch);writeFileSync(output,node,{flag:'wx',mode:0o700});chmodSync(output,0o755);
 return Object.freeze({version:DEVICE_NODE_VERSION,platform,arch,asset,archive_sha256:expected,node_sha256:createHash('sha256').update(node).digest('hex')});
}

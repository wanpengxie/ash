// Reuse the existing valid incompressible PNG fixture for ordinary and near-limit
// Android inputs. These are fresh fixture selections, not resized user images.
import {materialLargeImage} from '../../packages/core/test/fixtures/material-large-image';
import {inflateSync,deflateSync} from 'node:zlib';import {createHash} from 'node:crypto';import {writeFileSync,mkdirSync} from 'node:fs';
const out='build/project-first-send-local-20261013';mkdirSync(out,{recursive:true});const large=materialLargeImage();
const dataLength=large.bytes.readUInt32BE(33),rawLarge=inflateSync(large.bytes.subarray(41,41+dataLength)),width=512,height=511,raw=Buffer.alloc(height*(1+width*4));
for(let y=0;y<height;y++)rawLarge.copy(raw,y*(1+width*4)+1,y*(1+large.width*4)+1,y*(1+large.width*4)+1+width*4);
const crc=(bytes:Buffer)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
const chunk=(name:string,bytes:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,sum]);};
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
const ordinary=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
const padding=Buffer.concat([Buffer.from('fixture\0'),Buffer.alloc(4194304-large.bytes.length-12-8,0x78)]),exact=Buffer.concat([large.bytes.subarray(0,-12),chunk('tEXt',padding),large.bytes.subarray(-12)]);
if(exact.length!==4194304)throw Error('Incorrect PNG boundary fixture');
for(const [name,bytes]of [['ordinary-1MiB.png',ordinary],['exact-4MiB.png',exact]]as const){writeFileSync(`${out}/${name}`,bytes);console.log(JSON.stringify({name,byte_length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));}

import {deflateSync,inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
/** Deterministic valid near-limit RGBA PNG, deliberately incompressible. No source paths or credentials. */
export function materialLargeImage(){
 const width=1023,height=1023,raw=Buffer.alloc(height*(1+width*4));let seed=0x59f16c37;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;raw.writeUInt32BE(seed>>>0,y*(1+width*4)+1+x*4);}
 const crc=(bytes:Buffer)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const compressed=deflateSync(raw,{level:1});if(!inflateSync(compressed).equals(raw))throw Error('PNG compression mismatch');
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',compressed),chunk('IEND',Buffer.alloc(0))]);
 if(bytes.length>4194304||bytes.length<4194304-65536)throw Error('PNG is outside the near-4MiB acceptance range');
 return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),width,height};
}

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,type BigIntStats} from 'node:fs';
import {isAbsolute} from 'node:path';
export class NativeArtifactVersionError extends Error {
  constructor(readonly code:'unsupported'|'offline'){super('Native executable version evidence unavailable');}
}
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.gid,s.nlink].join(':');
const maximum=256n*1024n*1024n;
const issuer=Symbol('native-artifact-version');
/** Artifact-only fact. Never grants access or proves socket/process continuity. */
export class NativeArtifactVersion {
  #fd:number|undefined;#invalid=false;#path:string;#identity:string;#digest:string;#version:string;
  private constructor(token:symbol,path:string,fd:number,identity:string,digest:string,version:string){if(token!==issuer)throw new NativeArtifactVersionError('offline');this.#path=path;this.#fd=fd;this.#identity=identity;this.#digest=digest;this.#version=version;Object.freeze(this);}
  static open(path:string,expectedVersion:string):NativeArtifactVersion {
    let fd:number|undefined;
    try{
      if(!isAbsolute(path)||realpathSync(path)!==path)throw new NativeArtifactVersionError('unsupported');
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const before=fstatSync(fd,{bigint:true});
      if(!before.isFile()||before.nlink!==1n||before.size<4n||before.size>maximum||(before.mode&0o022n)!==0n||(before.mode&0o111n)===0n||![0n,BigInt(process.getuid!())].includes(before.uid))throw new NativeArtifactVersionError('unsupported');
      const identity=stamp(before),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0,n=0;
      while(total<=Number(maximum)&&(n=readSync(fd,buffer,0,Math.min(buffer.length,Number(maximum)+1-total),total))>0){
        if(total===0&&!['cffaedfe','cefaedfe','feedface','feedfacf','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(buffer.subarray(0,4).toString('hex')))throw new NativeArtifactVersionError('unsupported');
        hash.update(buffer.subarray(0,n));total+=n;
      }
      const check=()=>{const held=fstatSync(fd!,{bigint:true}),named=lstatSync(path,{bigint:true});if(realpathSync(path)!==path||!named.isFile()||named.isSymbolicLink()||stamp(held)!==identity||stamp(named)!==identity)throw new NativeArtifactVersionError('offline');};
      if(BigInt(total)!==before.size)throw new NativeArtifactVersionError('offline');check();
      const version=execFileSync(path,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:4096}).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
      check();if(!version||version!==expectedVersion)throw new NativeArtifactVersionError('offline');
      const proof=new NativeArtifactVersion(issuer,path,fd,identity,hash.digest('hex'),version);fd=undefined;return proof;
    }catch(error){if(error instanceof NativeArtifactVersionError)throw error;throw new NativeArtifactVersionError('offline');}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  readCurrentVersion(executable:string):string {
    try{if(this.#invalid||this.#fd===undefined||executable!==this.#path||realpathSync(this.#path)!==this.#path)throw 0;
      const held=fstatSync(this.#fd,{bigint:true}),named=lstatSync(this.#path,{bigint:true});
      if(!named.isFile()||named.isSymbolicLink()||stamp(held)!==this.#identity||stamp(named)!==this.#identity||!this.#digest)throw 0;
      return this.#version;
    }catch{closeNativeArtifactVersion(this);throw new NativeArtifactVersionError('offline');}
  }
  close():void{this.#invalid=true;const fd=this.#fd;this.#fd=undefined;if(fd!==undefined)closeSync(fd);}
}

// Capture the issuer's implementations once. Consumers never dispatch a method
// supplied by the alleged proof, including own/prototype overrides. Access to
// real # fields is the runtime brand check; copied prototypes have no brand.
const readProof=NativeArtifactVersion.prototype.readCurrentVersion;
const closeProof=NativeArtifactVersion.prototype.close;
export function readNativeArtifactVersion(proof:NativeArtifactVersion,executable:string):string {
  try{return readProof.call(proof,executable);}catch{throw new NativeArtifactVersionError('offline');}
}
export function closeNativeArtifactVersion(proof:NativeArtifactVersion):void {
  try{closeProof.call(proof);}catch{throw new NativeArtifactVersionError('offline');}
}

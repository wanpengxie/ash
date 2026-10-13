// Compile the same descriptor-only flock helper for the Android payload. No host install.
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildAndroidStateLock({output=join(ROOT,'build/android-state-lock/arm64'),ndkHome=process.env.ANDROID_NDK_HOME}={}){
  const sdk=process.env.ANDROID_HOME??process.env.ANDROID_SDK_ROOT??(process.platform==='darwin'?join(homedir(),'Library/Android/sdk'):join(homedir(),'android-sdk'));
  if(!ndkHome){const dir=join(sdk,'ndk'),versions=existsSync(dir)?readdirSync(dir).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})):[];if(versions.length)ndkHome=join(dir,versions.at(-1));}
  if(!ndkHome)throw Error('Android NDK is required to build ash-state-lock (set ANDROID_NDK_HOME)');
  const prebuilt=join(ndkHome,'toolchains/llvm/prebuilt'),hosts=readdirSync(prebuilt).filter(name=>name.startsWith(`${process.platform}-`));
  if(hosts.length!==1)throw Error('Expected one matching Android NDK host toolchain');
  const clang=join(prebuilt,hosts[0],'bin/aarch64-linux-android24-clang');
  mkdirSync(output,{recursive:true});const temporary=join(output,`.ash-state-lock-${randomUUID()}`);
  try{
    execFileSync(clang,['-std=c11','-O2','-Wall','-Wextra','-Werror','-fstack-protector-strong','-fPIE','-pie','-Wl,-z,relro,-z,now,-z,max-page-size=16384',join(ROOT,'packages/device/native/state-lock.c'),'-o',temporary],{stdio:'inherit'});
    chmodSync(temporary,0o755);const bytes=readFileSync(temporary);
    if(bytes.length<64||bytes.length>256*1024||!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(16)!==3||bytes.readUInt16LE(18)!==183)throw Error('Expected Android arm64 PIE ELF lock helper');
    const manifest={version:1,name:'ash-state-lock',platform:'android',arch:'arm64',sha256:createHash('sha256').update(bytes).digest('hex')};
    renameSync(temporary,join(output,'ash-state-lock'));writeFileSync(join(output,'native-helper.json'),JSON.stringify(manifest)+'\n',{mode:0o644});
    return output;
  }finally{rmSync(temporary,{force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(`Built Android descriptor lock helper: ${buildAndroidStateLock()}`);

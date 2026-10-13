import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from 'node:path';
import { discoverDefaultControlRuntime, type ControlRuntimeDiscoveryTestBackend } from '../src/setup/control-runtime-discovery';
import { VALIDATED_READ_SOURCE_VERSION } from '../src/collaboration/read-source';

function fixture() {
  const home='/fixture/home',socket=`/private/tmp/codex-daemon-501/${'a'.repeat(64)}`,managed=`${home}/.codex/packages/app-server-daemon/releases/local-${'b'.repeat(64)}-aarch64-apple-darwin/CodexCLI.app/Contents/MacOS/codex`;
  const state={socket,main:managed,uid:501,socketUid:501,releaseWritable:false,hash:'same-artifact',ambiguous:false,version:VALIDATED_READ_SOURCE_VERSION,changed:false};
  const commands:string[]=[];
  const backend:ControlRuntimeDiscoveryTestBackend={platform:'darwin',home,uid:501,arch:'arm64',canonical:path=>path.endsWith('/app-server-control.sock')?state.socket:normalize(path),file:path=>({kind:path.endsWith('/app-server-control.sock')?'symlink':path===state.socket?'socket':path.endsWith('/codex')?'file':'directory',uid:path===state.socket?state.socketUid:501,mode:state.releaseWritable&&path.includes('/releases')?0o777:0o700,identity:path+(state.changed&&path.endsWith('/app-server-control.sock')?'changed':'same')}),hash:path=>path===managed?state.hash:'same-artifact',run:(command)=>{commands.push(command);return command==='/usr/sbin/lsof'?`p77\nn${state.socket}\n${state.ambiguous?`p78\nn${state.socket}\n`:''}`:`${state.uid} ${state.main}\n`;},verify:config=>({pid:77,socket:config.socket,executable:config.executable,version:state.version,identity:'private-native-proof'})};
  return {backend,state,commands,managed,socket};
}
test('fixed current-user managed socket alias resolves to the protected release with native evidence',()=>{
  const f=fixture(),config=discoverDefaultControlRuntime('endpoint',{testing:f.backend});
  assert.equal(config.socket,f.socket);assert.equal(config.executable,f.managed);assert.deepEqual(config.supportedVersions,[VALIDATED_READ_SOURCE_VERSION]);
  assert.deepEqual(f.commands,['/usr/sbin/lsof','/bin/ps']);
});
test('managed alias cannot redirect to an arbitrary socket',()=>{
  const f=fixture();f.state.socket='/fixture/arbitrary.sock';assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:f.backend}),/managed shared socket/);assert.deepEqual(f.commands,[]);
});
test('foreign socket or process UID cannot select a shared runtime',()=>{
  for(const field of ['socketUid','uid'] as const){const f=fixture();f.state[field]=502;assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:f.backend}));}
});
test('multiple socket owners and an arbitrary main executable are rejected',()=>{
  const ambiguous=fixture();ambiguous.state.ambiguous=true;assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:ambiguous.backend}));
  const other=fixture();other.state.main='/fixture/another/codex';assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:other.backend}),/fixed managed release/);
});
test('writable managed release or different artifact bytes do not match the desktop bundle',()=>{
  const writable=fixture();writable.state.releaseWritable=true;assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:writable.backend}),/Unprotected/);
  const changed=fixture();changed.state.hash='different';assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:changed.backend}),/artifact differs/);
});
test('native version mismatch and alias changes during verification fail closed',()=>{
  const version=fixture();version.state.version='9.9.9';assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:version.backend}),/version changed/);
  const changed=fixture(),verify=changed.backend.verify;changed.backend.verify=config=>{const result=verify(config);changed.state.changed=true;return result;};assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:changed.backend}),/changed during discovery/);
});
test('unavailable native main evidence never falls back to an unverified executable',()=>{
  const f=fixture();f.backend.verify=()=>{throw Error('native evidence unavailable');};assert.throws(()=>discoverDefaultControlRuntime('endpoint',{testing:f.backend}),/native evidence unavailable/);
});

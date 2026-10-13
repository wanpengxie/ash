import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedEnv,profile,run,BINARY,bounded} from './material-host-isolation.mjs';
import {createMock,TOOL} from './material-host-mock-responses.mjs';

test('environment is created from constants, never inherited credentials/proxies',()=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-parent-secret';
  try {const e=isolatedEnv('/private/tmp/probe');assert.equal(e.OPENAI_API_KEY,undefined);assert.equal(e.HTTPS_PROXY,undefined);assert.equal(e.HOME,'/private/tmp/probe/home');assert.equal(e.CODEX_HOME,'/private/tmp/probe/config');assert.equal(e.CFFIXED_USER_HOME,e.HOME);assert.deepEqual(Object.keys(e).sort(),['__CFPREFERENCES_AVOID_DAEMON','CODEX_HOME','CFFIXED_USER_HOME','HOME','LANG','LC_ALL','PATH','RUST_LOG','TMPDIR','XDG_CACHE_HOME','XDG_CONFIG_HOME'].sort());}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
test('profile deny default, exact ports, temporary write, no Users content rule',()=>{
  const p=profile('/private/tmp/probe',BINARY,[12345,12346]);assert.match(p,/deny default/);assert.match(p,/localhost:12345/);assert.doesNotMatch(p,/allow network[^\n]*\*/);assert.doesNotMatch(p,/subpath "\/Users/);assert.match(p,/allow file-read\* file-write\* \(subpath "\/private\/tmp\/probe"\)/);assert.match(p,/literal "\/"/);
});
test('runner rejects another binary before creating output',async()=>{await assert.rejects(run({codex:'/usr/bin/true',output:'/unused'}),/explicit bundled/);});
test('bounded process has no shell interpretation and deadline kills child',async()=>{const r=await bounded(process.execPath,['-e','setTimeout(()=>{},10000)'],{},50);assert.equal(r.signal,'SIGKILL');});
test('mock refuses nonlocal-contract routes/models and never emits unregistered tools',async()=>{
  const events=[];const m=await createMock(e=>events.push(e));try{
    m.arm('case');assert.equal((await fetch(`http://127.0.0.1:${m.port}/login`,{method:'POST'})).status,400);
    assert.equal((await fetch(`http://127.0.0.1:${m.port}/v1/responses`,{method:'POST',body:JSON.stringify({model:'real-model'})})).status,400);
    m.arm('empty');const r=await fetch(`http://127.0.0.1:${m.port}/v1/responses`,{method:'POST',body:JSON.stringify({model:'fixture',tools:[],input:[]})});const text=await r.text();assert.match(text,/fixture complete/);assert.doesNotMatch(text,/"type":"function_call"/);
  }finally{await m.close();}
});
test('mock uses native-declared namespace; schema identities are forbidden; request count bounded',async()=>{
  const m=await createMock();try{
    m.arm('safe');const post=body=>fetch(`http://127.0.0.1:${m.port}/v1/responses`,{method:'POST',body:JSON.stringify(body)});
    const body={model:'fixture',tools:[{type:'namespace',name:'native_namespace',tools:[{type:'function',name:TOOL.name,parameters:TOOL.inputSchema}]}],input:[]};const text=await (await post(body)).text();assert.match(text,/"namespace":"native_namespace"/);assert.match(text,/response.function_call_arguments.done/);
    const bad={...body,tools:[{type:'function',name:TOOL.name,parameters:{...TOOL.inputSchema,properties:{native_id:{type:'string'}}}}]};assert.equal((await post(bad)).status,400);
    m.arm('bounded');for(let i=0;i<3;i++)assert.equal((await post(body)).status,200);assert.equal((await post(body)).status,400);
  }finally{await m.close();}
});

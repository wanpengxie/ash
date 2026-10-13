import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, mkdirSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReadAuthorization, parseReadAuthorization, readAuthorizationPath } from "../src/collaboration/authorization";
import { ConnectionSetupService } from "../src/setup/service";
import { DeviceKey } from "ash-gateway/client/client";
import { deviceIdForKey } from "ash-gateway/src/protocol";
import { fileSigner } from "../src/link";

const ownerKey = (await DeviceKey.generate()).publicKey;
const ownerId = await deviceIdForKey(ownerKey);
const pair = (state: string) => writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey }));

test("read authorization defaults closed and binds exact scopes to the local endpoint", () => {
  const state = mkdtempSync(join(tmpdir(), "ash-read-auth-"));
  try {
    pair(state);
    assert.equal(loadReadAuthorization(state, "node").state, "scope_required");
    const config = { version: 2, owner_id: ownerId, endpoint_id: "node", authorization_generation: 1, allowedCwds: ["/tmp/scope", "/tmp/scope/."] };
    assert.deepEqual(parseReadAuthorization(config, "node").allowedCwds, ["/tmp/scope"]);
    for (const invalid of [{ ...config, version: 1 }, { ...config, endpoint_id: "other" }, { ...config, allowedCwds: ["relative"] }, { ...config, allowedCwds: ["/" + "a".repeat(4096)] }, { ...config, method: "turn/start" }, { ...config, authorization_generation: 0 }]) assert.throws(() => parseReadAuthorization(invalid, "node"));
    writeFileSync(readAuthorizationPath(state), JSON.stringify(config));
    assert.equal(loadReadAuthorization(state, "node").state, "scope_required", "legacy v2 requires a source-bound grant");
    assert.equal(loadReadAuthorization(state, "other").state, "invalid_configuration");
    writeFileSync(readAuthorizationPath(state), "{malformed");
    assert.deepEqual(loadReadAuthorization(state, "node").allowedCwds, []);
    writeFileSync(readAuthorizationPath(state), " ".repeat(1024 * 1024 + 1));
    assert.equal(loadReadAuthorization(state, "node").state, "invalid_configuration");
  } finally { rmSync(state, { recursive: true, force: true }); }
});


function setup(stateDir:string,endpointId:string){return new ConnectionSetupService({stateDir,endpointId,testing:{allowBooleanVerification:true,readBinding:{source_id:'fixture-source',binding_revision:'a'.repeat(64)}},verification:{verifyScope:async()=>true,diagnostics:async()=>({})},runtime:{reserveChange:async()=>({assertCurrent:()=>undefined,release:()=>undefined})}});}
test('protected scope setter writes only explicit source-bound scopes privately; clear revokes authorization',async()=>{
 const state=realpathSync(mkdtempSync(join(tmpdir(),'ash-read-settings-')));pair(state);const signer=await fileSigner(state),service=setup(state,signer.id),predictable=`${readAuthorizationPath(state)}.tmp-${process.pid}`;
 try{writeFileSync(predictable,'preexisting file',{mode:0o644});const before=(await service.status()).precondition!;await service.applyScope({kind:'read',allowedCwds:['/tmp/one','/tmp/two']},before);const saved=loadReadAuthorization(state,signer.id);assert.equal(saved.version,3);assert.equal(saved.state,'ready');assert.deepEqual(saved.allowedCwds,['/tmp/one','/tmp/two']);assert.equal(statSync(readAuthorizationPath(state)).mode&0o777,0o600);assert.equal(readFileSync(predictable,'utf8'),'preexisting file');const current=(await service.status()).precondition!;await service.revoke('read',current);assert.equal(existsSync(readAuthorizationPath(state)),false);assert.equal(loadReadAuthorization(state,signer.id).state,'scope_required');const bytes=loadReadAuthorization(state,signer.id).authorization_revision;await assert.rejects(service.applyScope({kind:'read',allowedCwds:['relative']},(await service.status()).precondition!));assert.equal(loadReadAuthorization(state,signer.id).authorization_revision,bytes);}finally{service.close();rmSync(state,{recursive:true,force:true});}
});
test('concurrent protected scope setters leave one atomic source-bound revision without temporary filename collisions',async()=>{
 const state=realpathSync(mkdtempSync(join(tmpdir(),'ash-read-settings-')));pair(state);const signer=await fileSigner(state),services=Array.from({length:6},()=>setup(state,signer.id));
 try{const before=(await services[0].status()).precondition!;const outcomes=await Promise.allSettled(services.map((service,index)=>service.applyScope({kind:'read',allowedCwds:[`/tmp/concurrent-${index}`]},before)));assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);for(const result of outcomes)if(result.status==='rejected')assert.match(result.reason.message,/Connection setup: (stale|busy)/);const saved=loadReadAuthorization(state,signer.id);assert.equal(saved.state,'ready');assert.equal(saved.allowedCwds.length,1);assert.match(saved.allowedCwds[0],/^\/tmp\/concurrent-[0-5]$/);assert.match(saved.authorization_revision,/^[a-f0-9]{64}$/);assert.equal(statSync(readAuthorizationPath(state)).mode&0o777,0o600);assert.deepEqual(readdirSync(state).filter(name=>name.startsWith('collaboration-read.json.tmp-')),[]);}finally{services.forEach(service=>service.close());rmSync(state,{recursive:true,force:true});}
});

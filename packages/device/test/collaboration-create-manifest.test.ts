import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures/create-service-fixture";
import { parseCreateManifest } from "../src/collaboration/create-protocol";
test("manifest scope derives from current grant and is exposed only to current trusted owner",async t=>{
 const f=await serviceFixture(t);const absent=parseCreateManifest(f.service.manifest(),"endpoint");assert.equal(absent.grant_state,"grant_required");assert.equal(absent.authorization_revision,null);assert.deepEqual(absent.actions,[]);assert.equal(absent.scope,null);
 const good=parseCreateManifest(f.service.manifest(f.context),"endpoint");assert.deepEqual(good.scope,{kind:"exact_cwd",cwd:"/project"});assert.deepEqual(good.actions,["projects","apply","query","reconcile"]);assert.equal(good.limitations.native_readiness,"unknown");assert.equal(f.stats().constructions,0);
 f.revoke();assert.equal(parseCreateManifest(f.service.manifest(f.context)).scope,null);
});
test("strict manifest rejects fake scope, prefix/noncanonical cwd, arbitrary actions and metadata",async t=>{
 const f=await serviceFixture(t);const m=f.service.manifest(f.context);
 for(const patch of [{principal_id:"owner"},{scope:{kind:"single_work",cwd:"/project"}},{scope:{kind:"exact_cwd",cwd:"/project/../project"}},{scope:{kind:"exact_cwd",cwd:"project"}},{scope:{kind:"exact_cwd",cwd:"/project",project_id:"fake"}},{actions:["send_input"]},{actions:["apply","projects","query","reconcile"]},{scope:null},{limitations:{...m.limitations,native_readiness:"ready"}},{grant_state:"grant_required"}])assert.throws(()=>parseCreateManifest({...m,...patch}));assert.throws(()=>parseCreateManifest(m,"other"));
});

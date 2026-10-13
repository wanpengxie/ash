import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceKey } from 'ash-gateway/client/client';
import { CollaborationReadService } from '../src/collaboration/read-service';
import { ReadSourceError, releaseReadSource } from '../src/collaboration/read-source';
import { protectedReadFixture } from './fixtures/protected-read-fixture';
import { COLLABORATION_LIST } from '../src/collaboration/capabilities';

async function grantedFixture(mismatch = false) {
  const f = protectedReadFixture(), owner = await DeviceKey.generate();
  writeFileSync(join(f.state, 'paired.json'), JSON.stringify({ owner_key: owner.publicKey, grant_version: 1 }), { mode: 0o600 });
  const source = f.capture();
  try {
    writeFileSync(join(f.state, 'collaboration-read.json'), JSON.stringify({ version: 3, owner_id: owner.id, endpoint_id: 'node', authorization_generation: 1, allowedCwds: [f.project], source_id: source.source_id, binding_revision: mismatch ? '0'.repeat(64) : source.source_revision }), { mode: 0o600 });
  } finally { releaseReadSource(source); }
  return { ...f, owner };
}

// State-machine regression only: real v3 files/proof with an injected one-shot
// observation failure. This does not identify the browser reconnect failure.
for (const code of ['offline', 'stale'] as const) {
  test(`unchanged valid source grant recovers discovery after one transient ${code} capture`, async () => {
    const f = await grantedFixture();
    let service: CollaborationReadService | undefined;
    try {
      let captures = 0;
      service = new CollaborationReadService({ stateDir: f.state, nodeId: 'node', testing: { source: { ...f.port, capture: current => {
        if (++captures === 1) throw new ReadSourceError(code);
        return f.port.capture(current);
      } } } });
      const unavailable = service.manifest();
      // The persisted grant is confirmed; native runtime availability remains
      // unknown. This advertises authorization, never a successful read.
      assert.equal(unavailable.collaboration.authorization_state, 'ready');
      assert.equal(unavailable.collaboration.runtime_availability, 'unknown');
      assert.equal(unavailable.capabilities.length, 2);
      const recovered = service.manifest();
      assert.equal(recovered.collaboration.authorization_revision, unavailable.collaboration.authorization_revision);
      assert.equal(recovered.collaboration.authorization_generation, 1);
      assert.equal(recovered.collaboration.authorization_state, 'ready', `transient ${code} must not stay latched as scope_required with an unchanged valid grant; captures=${captures}`);
      assert.equal(recovered.capabilities.length, 2);
      assert.equal(captures, 2);
    } finally { await service?.close(); f.cleanup(); }
  });
}

test('dispatch maps transient stale source evidence to offline with owner and scope still current', async () => {
  const f = await grantedFixture();
  let transient = false;
  const service = new CollaborationReadService({ stateDir: f.state, nodeId: 'node', testing: { source: { ...f.port, current: proof => {
    if (transient) { transient = false; throw new ReadSourceError('stale'); }
    return f.port.current(proof);
  } } } });
  try {
    const prior = service.manifest();
    assert.equal(prior.collaboration.authorization_state, 'ready');
    transient = true;
    const result = await service.call(COLLABORATION_LIST, { version: 1, endpoint_id: 'node', authorization_revision: prior.collaboration.authorization_revision, page: { limit: 1 } }, undefined, { transportOwnerId: f.owner.id, isCurrent: () => true });
    assert.equal(result.ok, false);
    assert.equal((result.data as any).code, 'offline');
    assert.equal(service.manifest().collaboration.authorization_state, 'ready');
  } finally { await service.close(); f.cleanup(); }
});

test('actual source binding mismatch stays denied on each fresh capture', async () => {
  const f = await grantedFixture(true);
  let captures = 0;
  const service = new CollaborationReadService({ stateDir: f.state, nodeId: 'node', testing: { source: { ...f.port, capture: current => { captures++; return f.port.capture(current); } } } });
  try {
    const first = service.manifest(), second = service.manifest();
    assert.equal(first.collaboration.authorization_state, 'scope_required');
    assert.equal(second.collaboration.authorization_state, 'scope_required');
    assert.deepEqual(second.capabilities, []);
    assert.equal(captures, 2, 'each user refresh revalidates and still denies a binding mismatch');
    const result = await service.call(COLLABORATION_LIST, { version: 1, endpoint_id: 'node', authorization_revision: second.collaboration.authorization_revision, page: { limit: 1 } }, undefined, { transportOwnerId: f.owner.id, isCurrent: () => true });
    assert.equal(result.ok, false);
    assert.equal((result.data as any).code, 'permission_denied');
  } finally { await service.close(); f.cleanup(); }
});

for (const revoke of ['scope', 'pairing'] as const) {
  test(`actual ${revoke} revocation rejects the previous revision without recapturing source`, async () => {
    const f = await grantedFixture();
    let captures = 0;
    const service = new CollaborationReadService({ stateDir: f.state, nodeId: 'node', testing: { source: { ...f.port, capture: current => { captures++; return f.port.capture(current); } } } });
    try {
      const prior = service.manifest();
      assert.equal(prior.collaboration.authorization_state, 'ready');
      if (revoke === 'scope') unlinkSync(join(f.state, 'collaboration-read.json'));
      else writeFileSync(join(f.state, 'paired.json'), JSON.stringify({ owner_key: f.owner.publicKey, grant_version: 1, revoked: true }), { mode: 0o600 });
      const manifest = service.manifest();
      assert.notEqual(manifest.collaboration.authorization_state, 'ready');
      assert.deepEqual(manifest.capabilities, []);
      const result = await service.call(COLLABORATION_LIST, { version: 1, endpoint_id: 'node', authorization_revision: prior.collaboration.authorization_revision, page: { limit: 1 } }, undefined, { transportOwnerId: f.owner.id, isCurrent: () => true });
      assert.equal(result.ok, false);
      assert.equal((result.data as any).code, 'permission_denied');
      assert.equal(captures, 1);
    } finally { await service.close(); f.cleanup(); }
  });
}

test('account availability restoration revalidates on refresh without changing source or grant receipt',async()=>{
 const f=await grantedFixture();let available=false,captures=0;
 const service=new CollaborationReadService({stateDir:f.state,nodeId:'node',testing:{source:{...f.port,capture:current=>{captures++;if(!available)throw new ReadSourceError('unsupported');return f.port.capture(current);}}}});
 try{assert.equal(service.manifest().collaboration.authorization_state,'scope_required');available=true;const restored=service.manifest();assert.equal(restored.collaboration.authorization_state,'ready');assert.equal(restored.capabilities.length,2);assert.equal(captures,2);}finally{await service.close();f.cleanup();}
});

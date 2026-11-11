import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { definition, environment } from './test-support/studio-service-fixture.mjs';

test('owner revokes a webhook without source or approval lookup, including after restart', async t => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['webhook', 'edit-fields'], [[0, 0, 1, 0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const before = f.repository.lifecycle(w.kaRef), key = before.eventKey;
    f.restart();
    const source = t.mock.method(f.client.programs, 'getSource', async () => { throw new Error('source unavailable'); });
    const approval = t.mock.method(f.client.programs, 'getApproval', async () => { throw new Error('approval unavailable'); });
    const request = { kaRef: w.kaRef, sourceHash: w.sourceHash, active: false, activationId: randomUUID() };
    await assert.rejects(f.service.activate({ ...request, sourceHash: 'b'.repeat(64) }, () => {}), /revision changed/);
    assert.deepEqual(f.repository.lifecycle(w.kaRef), before);
    assert.deepEqual(await f.service.activate(request, () => assert.fail('revocation needs no export authority')),
      { kaRef: w.kaRef, sourceHash: w.sourceHash, mode: 'webhook', activation: { active: false } });
    const revoked = f.repository.lifecycle(w.kaRef);
    assert.equal(revoked.activation.active, false);
    assert.equal(revoked.eventKey, null);
    assert.equal(revoked.pendingUnpublication, null);
    assert.equal(revoked.revision, before.revision + 1);
    await f.service.activate(request, () => {});
    assert.deepEqual(f.repository.lifecycle(w.kaRef), revoked, 'a retry does not create a new revocation');
    assert.equal(source.mock.callCount(), 0);
    assert.equal(approval.mock.callCount(), 0);
    t.mock.restoreAll(); f.restart();
    await assert.rejects(f.service.event(key, { invocationId: randomUUID(), items: [{}] }), /Inactive/);
    assert.deepEqual(f.repository.lifecycle(w.kaRef), revoked);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});

for (const legacy of [false, true]) test(`schedule revocation retains cleanup during source outage and restart, legacy=${legacy}`, async t => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['schedule', 'edit-fields'], [[0, 0, 1, 0]]), () => {});
    await f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {});
    const before = f.repository.lifecycle(w.kaRef), native = f.native.get(before.providerId);
    if (legacy) {
      f.repository.db.exec('ALTER TABLE workflows DROP COLUMN mode; ALTER TABLE workflows DROP COLUMN source_hash;');
      f.restart(); // Migrate a saved revision that predates the local metadata.
      assert.equal(f.repository.lifecycle(w.kaRef).mode, null);
    }
    const source = t.mock.method(f.client.programs, 'getSource', async () => { throw new Error('source unavailable'); });
    f.setUnpublishFailure('reject');
    const request = { kaRef: w.kaRef, active: false, activationId: randomUUID() };
    await assert.rejects(f.service.activate(request, () => {}));
    const revoked = f.repository.lifecycle(w.kaRef);
    assert.equal(revoked.activation.active, false);
    assert.equal(revoked.eventKey, null);
    assert.equal(revoked.pendingUnpublication, request.activationId);
    assert.equal(native.active, true, 'provider cleanup really failed');
    f.restart();
    await f.service.poll();
    assert.deepEqual(f.repository.lifecycle(w.kaRef), revoked);
    f.setUnpublishFailure(null);
    await f.service.poll(); // Source remains unavailable: only provider cleanup recovers.
    assert.equal(native.active, false);
    assert.deepEqual(f.repository.lifecycle(w.kaRef), { ...revoked, pendingUnpublication: null });
    assert.equal(source.mock.callCount(), 0);
    t.mock.restoreAll();
    await assert.rejects(f.service.event(before.eventKey, { invocationId: randomUUID(), items: [{}] }), /Inactive/);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});

test('revocation fences a first activation still awaiting its saved source', async t => {
  const f = environment(), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  try {
    const w = await f.service.save(definition(['webhook', 'edit-fields'], [[0, 0, 1, 0]]), () => {});
    const getSource = f.client.programs.getSource;
    const source = t.mock.method(f.client.programs, 'getSource', async value => { entered.resolve(); await resume.promise; return getSource(value); });
    const denied = assert.rejects(f.service.activate({ kaRef: w.kaRef, active: true, activationId: randomUUID() }, () => {}), /activation changed/);
    await entered.promise;
    const activationId = randomUUID();
    await f.service.activate({ kaRef: w.kaRef, active: false, activationId }, () => {});
    assert.equal(source.mock.callCount(), 1, 'revocation must not wait for the blocked reader');
    resume.resolve(); await denied;
    assert.deepEqual(f.repository.activation(w.kaRef), { active: false, activationId });
    assert.equal(f.repository.lifecycle(w.kaRef).eventKey, null);
  } finally { resume.resolve(); f.close(); }
});

test('local deactivation rejects unknown and saved manual workflows before inspection', async t => {
  const f = environment();
  try {
    const w = await f.service.save(definition(['edit-fields'], []), () => {});
    const before = f.repository.lifecycle(w.kaRef);
    const source = t.mock.method(f.client.programs, 'getSource', async () => { throw new Error('source unavailable'); });
    for (const [kaRef, message] of [['urn:unknown', /Unknown saved graph/], [w.kaRef, /Webhook or Schedule/]])
      await assert.rejects(f.service.activate({ kaRef, active: false, activationId: randomUUID() }, () => {}), message);
    assert.deepEqual(f.repository.lifecycle(w.kaRef), before);
    assert.equal(source.mock.callCount(), 0);
  } finally { f.close(); }
});

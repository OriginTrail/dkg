import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import readProfile from './test-support/agent-read-profile.mjs';
import { createStudioFixtureContext } from './test-support/studio-service-fixture.mjs';

async function completedRun(t) {
  let allowed = true, checks = 0;
  const profile = { ...readProfile, async authorize(actor) {
    checks++; await readProfile.authorize(actor); if (!allowed) throw new Error('node access revoked');
  } };
  const context = createStudioFixtureContext(profile), f = context.environment();
  t.after(() => f.close());
  const actor = { id: 'owner', accountId: profile.accountId, role: 'owner' };
  const saved = await f.service.save(context.definition(['dkg-read'], []), () => {});
  const request = { kaRef: saved.kaRef, sourceHash: saved.sourceHash, invocationId: randomUUID(), itemsJson: '[{"sample":"a"}]' };
  const invoke = f.client.programs.invoke, retained = new Map();
  f.client.programs.invoke = async value => {
    if (!retained.has(value.invocationId)) retained.set(value.invocationId, await invoke(value));
    return retained.get(value.invocationId);
  };
  const first = await f.service.run(request, () => {}, actor);
  assert.equal(first.persisted, true); assert.ok(first.steps.length);
  assert.equal(f.invocations.length, 1);
  return { f, profile, actor, request, first, checks: () => checks, revoke() { allowed = false; } };
}

test('completed manual DKG replay reauthorizes node access after reopen without another dispatch', async t => {
  const { f, actor, request, first, checks, revoke } = await completedRun(t);
  assert.deepEqual(await f.service.run(request, () => {}, actor), first);
  const before = checks(); revoke(); f.restart();
  await assert.rejects(f.service.run(request, () => {}, actor), /node access revoked/);
  assert.equal(checks(), before + 1);
  assert.equal(f.invocations.length, 1);
});

for (const change of ['profile revision', 'workflow approval', 'component approval'])
  test(`manual DKG replay rechecks ${change} after pending profile authorization`, async t => {
    const { f, profile, actor, request } = await completedRun(t);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    profile.authorize = async received => { assert.deepEqual(received, actor); started.resolve(); await release.promise; };
    const pending = f.service.run(request, () => {}, actor);
    assert.equal(await Promise.race([started.promise.then(() => 'authorized'), pending.then(() => 'disclosed')]), 'authorized');
    try {
      if (change === 'profile revision') profile.revision = 'f'.repeat(64);
      if (change === 'workflow approval') f.approvals.get(request.kaRef).binding.enabled = false;
      if (change === 'component approval') f.setCatalog([]);
    } finally { release.resolve(); }
    await assert.rejects(pending);
    assert.equal(f.invocations.length, 1);
  });

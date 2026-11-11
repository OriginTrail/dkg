import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { dkgComponentStore } from './dkg-components.mjs';
import { profileParameters } from './dkg-profile.mjs';
import readProfile from './test-support/agent-read-profile.mjs';
import { measurements } from './test-support/measurement-profile.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'), hooks = { profile: async () => {}, journal: async () => {}, transport: async () => {} };
  const gates = []; let enabled = true, transports = 0;
  t.after(() => { for (const gate of gates) gate.release(); db.close(); });
  const profile = { ...readProfile, authorize: () => hooks.profile(), operations: {
    'dkg-read': { ...readProfile.operations['dkg-read'], enabled: () => enabled,
      async transport() { transports++; await hooks.transport(); return { graph: 'urn:test:measurements', measurements }; } },
  } };
  const node = { id: 'read', componentId: 'dkg-read', params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([k, v]) => [k, v.default])) };
  const workflow = { kaRef: 'urn:test:profile-fence', sourceHash: 'a'.repeat(64), definition: { entryId: node.id, nodes: [node], edges: [] } };
  const id = 'profile-fence', input = { itemsJson: '[{"sample":"a"}]', paramsJson: '{}', executionId: '' };
  const journal = { invocationId: id, revisionDigest: workflow.sourceHash, authority: { approved: true }, authorize: async () => {
    await hooks.journal(); return () => {}; // Invocation authority remains valid throughout these profile changes.
  } };
  const request = { blockId: 'read', items: [{ sample: 'a' }], effectId: 'effect-one', workflowId: 'native', executionId: '42' };
  const store = dkgComponentStore(db, profile);
  store.grant(workflow, journal, input, { id: 'owner', role: 'owner', accountId: profile.accountId });
  return {
    profile, disable: () => { enabled = false; }, get transports() { return transports; },
    call: () => store.call(request, workflow, journal, 'native', { invocationId: request.effectId, input }),
    row: () => db.prepare('SELECT result,response FROM dkg_component_calls WHERE id=?').get(id + ':read'),
    afterCompletion(callback) {
      db.function('after_completion', () => { queueMicrotask(callback); return 0; });
      db.exec(`CREATE TRIGGER after_completion AFTER UPDATE OF response ON dkg_component_calls
        WHEN NEW.response IS NOT NULL BEGIN SELECT after_completion(); END`);
    },
    pause(boundary, occurrence = 1) {
      const entered = Promise.withResolvers(), resume = Promise.withResolvers(); let calls = 0;
      hooks[boundary] = async () => { if (++calls === occurrence) { entered.resolve(); await resume.promise; } };
      const gate = { entered: entered.promise, release: () => resume.resolve() }; gates.push(gate); return gate;
    },
  };
}
const changes = [
  ['disabled operation', f => f.disable()],
  ['changed revision', f => { f.profile.revision = 'd'.repeat(64); }],
  ['changed profile identity', f => { f.profile.id = 'different-profile'; }],
];
const denied = { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409 };
for (const boundary of ['profile', 'journal']) for (const [name, change] of changes) {
  test(`${boundary} authorization rejects a ${name} before first dispatch`, { timeout: 10000 }, async t => {
    const f = fixture(t), gate = f.pause(boundary), rejected = assert.rejects(f.call(), denied);
    await gate.entered; change(f); gate.release(); await rejected;
    assert.equal(f.transports, 0); assert.equal(f.row(), undefined);
  });
  test(`${boundary} authorization rejects cached disclosure after a ${name}`, { timeout: 10000 }, async t => {
    const f = fixture(t); await f.call(); const retained = f.row();
    const gate = f.pause(boundary), rejected = assert.rejects(f.call(), denied);
    await gate.entered; change(f); gate.release(); await rejected;
    assert.equal(f.transports, 1); assert.deepEqual(f.row(), retained);
  });
}
for (const [name, change] of changes) {
  test(`dispatch authorization rejects a ${name} after call preparation`, { timeout: 10000 }, async t => {
    const f = fixture(t), gate = f.pause('journal', 2), rejected = assert.rejects(f.call(), denied);
    await gate.entered; change(f); gate.release(); await rejected;
    assert.equal(f.transports, 0); assert.equal(f.row().result, null); assert.equal(f.row().response, null);
  });
  test(`completion authorization rejects a ${name} without committing or returning output`, { timeout: 10000 }, async t => {
    const f = fixture(t), gate = f.pause('journal', 3), rejected = assert.rejects(f.call(), denied);
    await gate.entered; change(f); gate.release(); await rejected;
    assert.equal(f.transports, 1); assert.equal(f.row().result, null); assert.equal(f.row().response, null);
  });
}
test('a retry joining an active call rechecks the profile before sharing its completed response', { timeout: 10000 }, async t => {
  const f = fixture(t), transport = f.pause('transport'), disclosure = f.pause('journal', 5);
  const first = f.call(); await transport.entered;
  const rejected = assert.rejects(f.call(), denied);
  await setImmediate(); transport.release();
  assert.deepEqual(await first, { items: measurements });
  await disclosure.entered; f.disable(); disclosure.release(); await rejected;
  assert.equal(f.transports, 1); assert.deepEqual(JSON.parse(f.row().response), { items: measurements });
});
test('an account change during profile authorization cannot reuse the recorded owner', { timeout: 10000 }, async t => {
  const f = fixture(t), gate = f.pause('profile'), rejected = assert.rejects(f.call(), denied);
  await gate.entered; f.profile.accountId = 'different-account'; gate.release(); await rejected;
  assert.equal(f.transports, 0); assert.equal(f.row(), undefined);
});
test('a new callback rechecks the profile after journal completion before returning its response', async t => {
  const f = fixture(t); f.afterCompletion(f.disable);
  await assert.rejects(f.call(), denied);
  assert.equal(f.transports, 1);
  assert.deepEqual(JSON.parse(f.row().response), { items: measurements }, 'completion precedes the revocation; disclosure does not');
});

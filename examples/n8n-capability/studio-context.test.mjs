import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createStudioContext, loadStudioContext } from './studio-context.mjs';
import { defaultComponentRegistry } from './component-registry.mjs';
import { standaloneComponentWorkflow } from './component-workflows.mjs';
import { createStudioFixtureContext } from './test-support/studio-service-fixture.mjs';
import profile from './test-support/measurement-profile.mjs';

test('two explicit profiles keep compiler, service and descriptor ownership isolated in one process', async t => {
  const first = { ...profile, parameters: structuredClone(profile.parameters) };
  const second = { ...profile, id: 'other-profile', revision: 'b'.repeat(64), parameters: structuredClone(profile.parameters) };
  second.parameters['dkg-read'].dataset = { ...second.parameters['dkg-read'].dataset, default: 'other-set', options: ['other-set'] };
  const a = createStudioFixtureContext(first), b = createStudioFixtureContext(second);
  const left = a.environment(), right = b.environment();
  t.after(() => { left.close(); right.close(); });
  const [savedA, savedB] = await Promise.all([
    left.service.save(a.definition(['dkg-read'], []), () => assert.fail('unexpected export')),
    right.service.save(b.definition(['dkg-read'], []), () => assert.fail('unexpected export')),
  ]);
  assert.notEqual(savedA.kaRef, savedB.kaRef);
  const sourceA = left.sources.get(savedA.kaRef).source, sourceB = right.sources.get(savedB.kaRef).source;
  assert.equal(left.compiler.readStudio(sourceA).kaRef, savedA.kaRef);
  assert.equal(right.compiler.readStudio(sourceB).kaRef, savedB.kaRef);
  assert.throws(() => left.compiler.readStudio(sourceB));
  assert.throws(() => right.compiler.readStudio(sourceA));
  const disabled = await loadStudioContext({});
  assert.equal(disabled.profile, null);
  assert.throws(() => disabled.compiler.readStudio(sourceA), { code: 'WORKFLOW_CAPABILITY_CHANGED' });
  assert.equal(defaultComponentRegistry.componentRegistry.some(c => c.category === 'DKG'), false);
  const descriptor = a.context.registry.component('dkg-read');
  assert.throws(() => { descriptor.parameters.dataset.default = 'changed'; }, TypeError);
  first.parameters['dkg-read'].dataset.default = 'changed-after-startup';
  assert.equal(descriptor.parameters.dataset.default, 'set-7');
  assert.equal(b.context.registry.component('dkg-read').parameters.dataset.default, 'other-set');
  assert.equal((await left.service.get(savedA.kaRef)).workflow.sourceHash, savedA.sourceHash);
  assert.equal((await right.service.get(savedB.kaRef)).workflow.sourceHash, savedB.sourceHash);
});

test('explicit profile context preserves pre-refactor guest bytes, native hashes and workflow identity', () => {
  // Captured from 270e17eb050db3e2ee68847bd26df75e248de93c with this unchanged fictional profile.
  const expected = JSON.parse(readFileSync(new URL('./test-fixtures/profile-revisions.json', import.meta.url)));
  const { registry, compiler } = createStudioContext({ profile });
  const hash = value => createHash('sha256').update(value).digest('hex'), hashes = {};
  const ids = ['dkg-read', 'invoke-dkg-program', 'dkg-write'];
  for (const id of ids) {
    hashes[id + '/source'] = hash(registry.componentProgramSource(id));
    hashes[id + '/native'] = hash(JSON.stringify(standaloneComponentWorkflow(id, 'fixture-flow', { id: 'fixture', name: 'Fixture' }, { registry })));
  }
  const definition = { id: '123e4567-e89b-42d3-a456-426614174099', name: 'Profile fingerprint', entryId: 'n0',
    nodes: ids.map((id, i) => ({ id: 'n' + i, componentId: id, kaRef: 'urn:demo:n8n:component:' + id + ':fixture', sourceHash: 'a'.repeat(64),
      params: Object.fromEntries(Object.entries(registry.component(id).parameters).map(([k, v]) => [k, v.default])), x: i * 240, y: 0 })),
    edges: [{ from: 'n0', to: 'n1', output: 0, input: 0 }, { from: 'n1', to: 'n2', output: 0, input: 0 }] };
  const compiled = compiler.compileStudio(definition, { fixture: true, headerCredential: { id: 'fixture', name: 'Fixture' }, graphId: 'source-fixture', owner: '0x' + '1'.repeat(40) });
  hashes['profile/revision'] = profile.revision;
  hashes['studio/source'] = hash(compiler.studioProgramSource(compiled));
  hashes['studio/native'] = hash(JSON.stringify(compiled.workflow));
  hashes['studio/kaRef'] = compiled.kaRef;
  assert.deepEqual(hashes, expected);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStudio, readStudio, studioProgramSource } from './studio-definition.mjs';
import { compileStudio as compileLegacy, studioProgramSource as legacySource } from './studio-definition-v1.mjs';
import { prepareStudioExecution, studioExecutionPlan } from './studio-execution-plan.mjs';
import { createStudioFixtureContext, graphId, owner } from './test-support/studio-service-fixture.mjs';

const { definition } = createStudioFixtureContext();
const native = definition(['limit'], []), program = structuredClone(native);
program.nodes[0] = { ...program.nodes[0], componentId: 'run-program', kaRef: 'urn:test:program', params: {
  operationIri: 'urn:test:operation', version: '1.0.0', inputMode: 'each-item', inputMapping: '{{ $json }}',
} };
const options = { graphId, owner, fixture: true };

for (const [kind, value] of [['native-n8n', native], ['dkg-program', program]]) {
  test(kind + ' compiles and reads back with one explicit execution discriminator', () => {
    const compiled = compileStudio(value, options), source = studioProgramSource(compiled), read = readStudio(source);
    assert.equal(compiled.kind, kind); assert.equal(read.kind, kind);
    assert.equal(Object.hasOwn(compiled, 'executor'), false);
    assert.equal(read.kaRef, compiled.kaRef); assert.equal(studioProgramSource(read), source);
    const plan = studioExecutionPlan(read, graphId);
    assert.equal(plan.upload.source, source);
    if (kind === 'native-n8n') {
      assert.deepEqual(read.grant, compiled.grant);
      assert.deepEqual(plan.approval.n8n, compiled.grant);
      assert.deepEqual(plan.upload.requiredTools, ['urn:dkg:tool:n8n']);
    } else {
      assert.deepEqual(read.ordered, compiled.ordered);
      assert.deepEqual(plan.upload.permittedPrograms, ['urn:test:program']);
      assert.deepEqual(plan.approval.typescript.children, [{ graphId, operationIri: 'urn:test:operation' }]);
    }
  });
}

test('historical native sources normalize at readback and serialize to identical bytes', () => {
  const compiled = compileLegacy(native, options), source = legacySource(compiled), read = readStudio(source);
  assert.equal(read.kind, 'native-n8n'); assert.equal(read.legacy, true); assert.equal(read.kaRef, compiled.kaRef);
  assert.equal(studioProgramSource(read), source);
  assert.equal(studioExecutionPlan(read, graphId).upload.source, source);
});

test('preparation provisions only the native compiler variant', async () => {
  const provisioned = [];
  const provision = async value => { provisioned.push(value); return compileStudio(value, { ...options, providerId: 'allocated-native' }); };
  const saved = await prepareStudioExecution(native, graphId, provision);
  assert.equal(saved.compiled.kind, 'native-n8n'); assert.equal(saved.compiled.grant.workflowId, 'allocated-native');
  assert.deepEqual(saved.plan.approval.n8n, saved.compiled.grant);
  const prepared = await prepareStudioExecution(program, graphId, provision);
  assert.equal(prepared.compiled.kind, 'dkg-program'); assert.deepEqual(provisioned, [saved.compiled.definition]);
});

test('serialization rejects a missing or unsupported internal variant', () => {
  const compiled = compileStudio(native, options);
  for (const kind of [undefined, 'dkg', 'unknown']) {
    assert.throws(() => studioProgramSource({ ...compiled, kind }), { code: 'INVALID_WORKFLOW' });
    assert.throws(() => studioExecutionPlan({ ...compiled, kind }, graphId), { code: 'INVALID_WORKFLOW' });
  }
});

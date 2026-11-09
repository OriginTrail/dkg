import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryTests } from '../qa-boundaries.mjs';
import { change, pullRequestPlan } from './ci-plan-fixtures.mjs';
for (const file of ['packages/agent/src/dkg-agent-lifecycle.ts','packages/agent/src/dkg-agent-rfc64-seed-fetch.ts','packages/core/src/network.ts']) {
  test(`startup and network changes retain early detectors and required agent CI: ${file}`, () => {
    assert.ok(boundaryTests([file]).includes('test/rfc64-catalog-head-replay-peers.test.ts'));
    assert.ok(boundaryTests([file]).includes('test/rfc64-unregistered-seed-fetch-agent.test.ts'));
    assert.equal(pullRequestPlan([change(file)]).lanes.tornado_agent, true);
  });
}
test('storage schema and dependency edits select persistence checks', () => {
  for (const file of ['packages/storage/src/oxigraph.ts','packages/agent/src/rfc64/inventory-v1/migrations.ts','pnpm-lock.yaml','packages/agent/package.json']) {
    assert.ok(boundaryTests([file]).includes('test/rfc64-inventory-v1-lifecycle.test.ts'));
    assert.equal(pullRequestPlan([change(file)]).lanes.tornado_agent, true);
  }
});
test('docs are not misrepresented as executing a boundary test; selection deduplicates', () => {
  assert.deepEqual(boundaryTests(['README.md']), []);
  assert.deepEqual(boundaryTests(['package.json','pnpm-lock.yaml']), boundaryTests(['package.json']));
});

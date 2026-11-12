import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as compiler from './studio-definition.mjs';
import { component } from './component-registry.mjs';
import { definition } from './test-support/studio-service-fixture.mjs';
import { verifySourceBudget } from './test-support/studio-source-budget-checks.mjs';
import { verifyInventory } from './test-support/studio-inventory-checks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function template() {
  const graph = definition(['edit-fields'], []);
  graph.nodes[0].kaRef = 'urn:demo:n8n:component:edit-fields:unit';
  return graph;
}
test('serialized composition source budget is checked before native or graph persistence', async () => {
  await verifySourceBudget(root, compiler, component('edit-fields'), template());
});
test('native bridge publishes private recipes, enforces route authorization and survives catalog failures', async () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-components-http-'));
  try {
    await verifyInventory(root, state, component('edit-fields'), {
      kaRef: 'urn:demo:nos:studio:fixture', sourceHash: 'b'.repeat(64), definition: template(),
    });
  } finally { rmSync(state, { recursive: true, force: true }); }
});

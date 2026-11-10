import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudioExecutionHarness, memoryStudioClient } from './test-support/studio-execution-harness.mjs';
import { fixtureProgramAuthority } from './test-support/studio-authority-fixture.mjs';

test('generated Read/Write callbacks accept normalized pinned snapshots but reject changed authority or structure', async () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-callback-'));
  const client = memoryStudioClient();
  const h = createStudioExecutionHarness({ state, graphId: 'test-studio', owner: '0x' + '1'.repeat(40), config: {}, client, loadOutputs: async () => [], programAuthority: fixtureProgramAuthority });
  const originalRevision = h.profile.revision;
  try {
    const workflow = await h.service.save(h.definition, () => {});
    const invocationId = randomUUID();
    const input = { itemsJson: '[{}]', paramsJson: JSON.stringify(h.definition.nodes[0].params), executionId: '' };
    await assert.rejects(h.service.run({ kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson: input.itemsJson, invocationId }, () => {}, h.actor), /stop after recording/);
    const effectId = 'urn:sr:effect:' + invocationId + ':0';
    await h.runtimeFetch('http://127.0.0.1:5679/webhook/test', { method: 'POST', body: JSON.stringify({ invocationId: effectId, input }) });
    assert.deepEqual(h.effects, ['read', 'write']);
    assert.equal(h.assets.size, 1);
    const request = h.requestFor(effectId, 'read', [{}]);
    for (const invalidEffect of [invocationId, 'urn:sr:effect:' + invocationId, effectId + ' invalid'])
      await assert.rejects(h.service.dkgComponent({ ...request, effectId: invalidEffect }),
        { code: 'DKG_COMPONENT_UNCONFIRMED', status: 409, message: 'Native execution identity required.' });
    for (const alter of [
      value => ({ ...value, id: '43' }),
      value => ({ ...value, workflowVersionId: 'foreign-version' }),
      value => ({ ...value, workflowId: 'another-workflow' }),
      value => { value.workflowData.nodes.find(n => n.credentials).credentials = { httpHeaderAuth: { id: 'foreign' } }; return value; },
      value => { value.workflowData.connections = {}; return value; },
    ]) {
      h.controls.snapshot = alter;
      await assert.rejects(h.service.dkgComponent(request), /does not match/);
    }
    h.controls.snapshot = v => v;
    const published = h.native.get('native1').activeVersion;
    const original = structuredClone(published.nodes);
    published.nodes[0].parameters = { unauthorized: true };
    await assert.rejects(h.service.dkgComponent(request), /does not match/);
    published.nodes = original;
    client.approvals.get(workflow.kaRef).binding.enabled = false;
    await assert.rejects(h.service.dkgComponent(request), /approval/);
    client.approvals.get(workflow.kaRef).binding.enabled = true;
    h.profile.revision = 'f'.repeat(64);
    await assert.rejects(h.service.dkgComponent(request), /profile changed/);
    h.profile.revision = originalRevision;
    h.controls.owner = false;
    await assert.rejects(h.service.dkgComponent(request), /owner revoked/);
    assert.deepEqual(h.effects, ['read', 'write']);
  } finally { h.profile.revision = originalRevision; h.close(); rmSync(state, { recursive: true, force: true }); }
});

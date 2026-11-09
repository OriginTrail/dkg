import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import profile, { measurements } from '../../../examples/n8n-capability/test-support/measurement-profile.mjs';

// Select the fictional operator profile before loading the registry/service.
process.env.NOS_DKG_PROFILE_MODULE = fileURLToPath(new URL('../../../examples/n8n-capability/test-support/measurement-profile.mjs', import.meta.url));
const { environment, definition } = await import('../../../examples/n8n-capability/test-support/studio-service-fixture.mjs');

test('saved Studio DKG Read/Write callbacks accept normalized execution parameters and retain authority checks', async () => {
  const effects = [];
  profile.transport = async (payload, operation) => {
    effects.push(operation);
    if (operation === 'read') return { graph: 'urn:test:measurements', measurements };
    return { contextGraphId: profile.targetGraph, digest: payload.digest, name: payload.name,
      metadata: { status: 'wm-sealed', reservedUal: 'urn:test:asset:1' }, readbackVerified: true };
  };
  const f = environment(), revision = profile.revision;
  try {
    const w = await f.service.save(definition(['dkg-read', 'dkg-write'], [[0,0,1,0]]), () => {});
    const approval = f.approvals.get(w.kaRef);
    assert.equal(approval.typescript.children.length, 2);
    assert.deepEqual(f.sources.get(w.kaRef).permittedPrograms, w.definition.nodes.map(n => n.kaRef));
    const native = f.native.get(f.provider.row(w.kaRef).provider_id);
    const snapshot = structuredClone({ ...native.activeVersion, settings: native.settings });
    // n8n normalizes HTTP Request body/header parameters in execution snapshots.
    for (const node of snapshot.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest'))
      node.parameters = { method: 'POST', sendBody: true, specifyBody: 'json', jsonBody: '{"normalized":true}' };
    const execution = { id: '42', workflowId: native.id, workflowVersionId: native.versionId, workflowData: snapshot };
    f.executions.set('42', execution);
    const invocationId = randomUUID();
    const request = (blockId, items) => ({ workflowId: native.id, executionId: '42', blockId, items,
      effectId: 'urn:sr:effect:' + invocationId + ':0' });
    const invoke = f.client.programs.invoke;
    // The real save/run path creates the profile grant before dispatch.
    f.client.programs.invoke = async value => {
      const read = await f.service.dkgComponent(request('n0', [{}]));
      assert.deepEqual(read.items, measurements);
      const write = await f.service.dkgComponent(request('n1', read.items));
      assert.equal(write.items[0].readbackVerified, true);
      return invoke(value);
    };
    assert.equal((await f.service.run({ kaRef: w.kaRef, sourceHash: w.sourceHash,
      invocationId, itemsJson: '[{}]' }, () => {})).readbackVerified, true);
    assert.deepEqual(effects, ['read', 'write']);
    f.restart();
    assert.deepEqual((await f.service.dkgComponent(request('n0', [{}]))).items, measurements);
    for (const mutate of [
      e => { e.workflowVersionId = 'other-version'; },
      e => { e.workflowId = 'other-workflow'; },
      e => { e.workflowData.connections = {}; },
      e => { e.workflowData.nodes[0].credentials = { httpHeaderAuth: { id: 'other', name: 'Other' } }; },
    ]) {
      const changed = structuredClone(execution); mutate(changed); f.executions.set('42', changed);
      await assert.rejects(f.service.dkgComponent(request('n0', [{}])), /does not match/);
    }
    f.executions.set('42', execution);
    const parameters = native.activeVersion.nodes[0].parameters;
    native.activeVersion.nodes[0].parameters = { tampered: true };
    await assert.rejects(f.service.dkgComponent(request('n0', [{}])), /does not match/);
    native.activeVersion.nodes[0].parameters = parameters;
    approval.binding.enabled = false;
    await assert.rejects(f.service.dkgComponent(request('n0', [{}])), /approval/);
    approval.binding.enabled = true;
    profile.revision = 'f'.repeat(64);
    await assert.rejects(f.service.dkgComponent(request('n0', [{}])), /profile changed/);
    assert.deepEqual(effects, ['read', 'write']);
  } finally { profile.revision = revision; f.close(); }
});

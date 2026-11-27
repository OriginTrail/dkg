import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import baseProfile, { measurements } from '../../../examples/n8n-capability/test-support/measurement-profile.mjs';

import { createStudioFixtureContext } from '../../../examples/n8n-capability/test-support/studio-service-fixture.mjs';

test('saved Studio DKG Read/Write callbacks accept normalized execution parameters and retain authority checks', async () => {
  const profile = { ...baseProfile };
  const { environment, definition } = createStudioFixtureContext(profile);
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
    assert.equal(approval.typescript.children.length, 0);
    assert.deepEqual(f.sources.get(w.kaRef).permittedPrograms, []);
    const native = f.native.get(f.repository.lifecycle(w.kaRef).providerId);
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
      execution.data = { executionData: { nodeExecutionStack: [{
        node: snapshot.nodes.find(node => node.name === 'Receive input'),
        data: { main: [[{ json: { body: { invocationId: 'urn:sr:effect:' + value.invocationId + ':0', input: value.inputs[0] } } }]] },
      }] }, resultData: { runData: {} } };
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


test('removing a DKG profile preserves saved pins and leaves unrelated workflows listable', async () => {
  const { environment, definition } = createStudioFixtureContext({ ...baseProfile });
  const f = environment();
  try {
    const ordinary = await f.service.save(definition(['edit-fields'], []), () => {});
    const dependent = [];
    for (const ids of [['dkg-read'], ['dkg-read', 'invoke-dkg-program'], ['dkg-read', 'dkg-write']]) {
      dependent.push(await f.service.save(definition(ids, ids.length === 1 ? [] : [[0,0,1,0]]), () => {}));
    }
    const before = dependent.map(w => ({ row: { ...f.repository.lifecycle(w.kaRef) }, source: structuredClone(f.sources.get(w.kaRef)) }));
    const env = { ...process.env }; delete env.NOS_DKG_PROFILE_MODULE; delete env.NOS_STUDIO_SESSION_FILE;
    const bridgeUrl = new URL('../../../examples/n8n-capability/bridge.mjs', import.meta.url).href;
    const registryUrl = new URL('../../../examples/n8n-capability/component-registry.mjs', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { Readable } from 'node:stream';
      const { createCapabilityBridge } = await import(${JSON.stringify(bridgeUrl)});
      const { componentRegistry, component } = await import(${JSON.stringify(registryUrl)});
      const input = JSON.parse(readFileSync(0, 'utf8')), sources = new Map(input.sources), approvals = new Map(input.approvals);
      let dispatches = 0;
      const bridge = createCapabilityBridge({ graphId: 'n8n-capability-poc', owner: '0x' + '1'.repeat(40),
        config: {}, agent: { query: async () => ({ bindings: [] }) },
        client: { programs: { listApprovals: async () => [], getSource: async ({ programIri }) => sources.get(programIri),
          getApproval: async ({ operationIri }) => approvals.get(operationIri),
          invoke: async () => { dispatches++; throw new Error('dispatch forbidden'); } } },
        studioOptions: { state: input.state, fetchImpl: async () => { dispatches++; throw new Error('native access forbidden'); } } });
      try {
        assert.equal(componentRegistry.some(c => c.category === 'DKG'), false);
        const req = Readable.from([]); req.method = 'GET'; req.headers = { authorization: 'Bearer l1-owner-a' };
        req.url = '/spike/ka/accounts/account-a/capabilities/studio';
        let status, response;
        await bridge.handle(req, { writeHead: value => { status = value; }, end: value => { response = JSON.parse(value); } }, req.url);
        assert.equal(status, 200, JSON.stringify(response));
        assert.deepEqual(response.workflows.map(w => w.kaRef), [input.ordinary.kaRef]);
        assert.equal(response.workflows[0].sourceHash, input.ordinary.sourceHash);
        assert.equal(response.workflows[0].approved, true);
        const unavailable = e => e.code === 'WORKFLOW_CAPABILITY_CHANGED' && /profile/.test(e.message);
        for (const saved of input.dependent) {
          await assert.rejects(bridge.studio.get(saved.kaRef, saved.sourceHash), unavailable);
          await assert.rejects(bridge.studio.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash,
            invocationId: '11223344-1234-4234-8234-123456789abc', itemsJson: '[{}]' }, () => {}), unavailable);
          await assert.rejects(bridge.studio.save(saved.definition, () => {}), unavailable);
        }
        for (const id of ['dkg-read', 'invoke-dkg-program', 'dkg-write']) assert.throws(() => component(id), unavailable);
        assert.throws(() => component('unknown-component'), { code: 'INVALID_COMPONENT' });
        assert.equal(dispatches, 0);
        console.log('verified');
      } finally { bridge.close(); }
    `;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8',
      input: JSON.stringify({ state: f.state, sources: [...f.sources], approvals: [...f.approvals], ordinary, dependent }) }).trim(), 'verified');
    assert.deepEqual(dependent.map(w => ({ row: { ...f.repository.lifecycle(w.kaRef) }, source: f.sources.get(w.kaRef) })), before);
    f.restart();
    assert.equal((await f.service.list()).length, 4);
    for (const saved of dependent) assert.equal((await f.service.get(saved.kaRef)).workflow.sourceHash, saved.sourceHash);
    assert.equal(f.invocations.length, 0);
  } finally { f.close(); }
});
